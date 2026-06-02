import { randomUUID } from 'node:crypto';
import { type VoyageEmbedder } from '@risezome/engine/embed';
import type {
  Synthesizer,
  SynthesisSource,
  SynthesisUsage,
} from '@risezome/engine/synthesize';
import { parseSynthesisOutput, verifyCitations } from '@risezome/engine/synthesize';
import { hybridSearch, isLowConfidenceHits } from './corpus-search';
import { optionalReranker } from './reranker';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc, type WinningChunk } from './parent-doc';
import { optionalQueryExpander } from './query-expand';
import { augmentQuery } from '@risezome/engine/query-expand';
import { shouldExpandOnMiss } from '@risezome/engine/query-route';
import {
  classifyRelevanceHeuristic,
  type RelevanceClassifier,
} from '@risezome/engine/relevance';
import {
  type Classifier,
  ClassifierProviderError,
  isToolShaped,
} from '@risezome/engine/router';
import {
  type Skill,
  type SkillContext,
  SkillExecutionError,
  formatAsSource,
} from '@risezome/engine/skills';
import { type SkillRegistry } from '@risezome/engine/skills';
import { decideToolSource, mergeToolSource } from './retrieval-safety-net';
import type { MeetingSummary } from '@risezome/engine/summarize';
import type { SupabaseClient } from '@supabase/supabase-js';
import { persistAndBroadcast } from './db.js';

/**
 * Pragmatic retrieval loop for V1: on every Nth final utterance the
 * bot-worker embeds a small rolling window of recent speech, runs the
 * same vector search RPC the /debug/ask page uses, and surfaces the
 * top-K matches as cards. No synthesis layer yet — that lands when
 * we lift the full RetrievalPipeline (Anthropic synthesizer + relevance
 * classifier + skills) from apps/daemon into the engine.
 *
 * Throttling:
 *   - At least UTTERANCE_THRESHOLD final utterances since last retrieval
 *   - AND at least COOLDOWN_MS elapsed
 * Both gates keep us from hammering Voyage / Postgres on a chatty meeting.
 *
 * Card shape mirrors @risezome/hud-ui's CardEvent so the live page's
 * reducer can ingest the broadcast verbatim. We deliberately don't
 * import the type cross-package (hud-ui has React peer deps); instead
 * we keep a local interface that's a structural subset.
 */

// Retrieve on EVERY finalized utterance — a clear single question
// should fire retrieval immediately rather than wait for two more
// utterances. The 10s cooldown still prevents spam (max one retrieval
// per 10s); the relevance classifier filters filler before the
// expensive synthesis call. Live testing showed threshold=3 made the
// system feel laggy: "What models are used?" wouldn't trip retrieval
// because it was only one utterance.
const UTTERANCE_THRESHOLD = 1;
const COOLDOWN_MS = 10_000; // ... but at most once per 10s
const TOP_K = 3;
const WINDOW_UTTERANCES = 8; // last 8 final utterances form the query

// Voyage embeddings are trained on natural sentences, not keyword bags.
// Concatenating key_terms can EITHER boost recall on short follow-up
// utterances OR degrade similarity. Ship gated behind an env flag for
// the first live test so the behavior can be A/B'd against a recorded
// session. Default OFF — mirrors the debug-path flag.
const KEY_TERMS_BOOST_ENABLED = process.env.RISEZOME_KEY_TERMS_BOOST === 'true';

export interface RetrievalRuntime {
  /** Concatenated text of recent final utterances. */
  recentFinals: string[];
  utteranceCountSinceLastRetrieval: number;
  lastRetrievalAt: number;
  /**
   * Most recent cardId surfaced for a given docId in this meeting.
   * Used by the stale-score retractor: when a new card arrives for a
   * docId that already has a live (non-retracted, non-pinned) card,
   * we retract the prior card so the stream doesn't fill with
   * duplicates of the same source chunk.
   */
  liveCardByDocId: Map<string, string>;
}

export function newRetrievalRuntime(): RetrievalRuntime {
  return {
    recentFinals: [],
    utteranceCountSinceLastRetrieval: 0,
    lastRetrievalAt: 0,
    liveCardByDocId: new Map<string, string>(),
  };
}

interface CardPayload {
  cardId: string;
  docId: string;
  source: string;
  type: string;
  title: string;
  /** Truncated preview (400 chars). */
  snippet: string;
  /** Full chunk text (substrate for the highlight substring search). */
  body: string;
  score: number;
  rank: number;
  /** True when the matched chunk is the doc's generated summary (U6) — the
   *  card body leads with the summary excerpt; UI flags it as a summary view. */
  isSummary?: boolean;
  metadata: Record<string, unknown>;
  surfacedAt: number;
  triggeredBy: 'window';
  utteranceId: string;
  traceId: string;
  url?: string;
}

export async function maybeRetrieveAndEmit(args: {
  runtime: RetrievalRuntime;
  utteranceText: string;
  utteranceId: string;
  meetingId: string;
  orgId: string;
  db: SupabaseClient;
  embedder: VoyageEmbedder;
  /** Optional Anthropic synthesizer. When present, after cards are
   *  emitted we run them through synthesis and stream batched
   *  synthesisDelta broadcasts to the live page's right panel. */
  synthesizer?: Synthesizer;
  /** Called with the grounded answer body when a synthesis succeeds (not
   *  refused/ungrounded). Used to close the loop: the answer is never spoken,
   *  so feeding it to the summarizer is how an answered open question retires. */
  onGroundedAnswer?: (text: string) => void;
  /** Optional LLM relevance classifier. Used ONLY for `ambiguous`
   *  heuristic results — `clearly_filler` short-circuits without an
   *  API call, `clearly_substantive` always synthesizes. When unset,
   *  ambiguous utterances default to synthesizing (same fail-open
   *  posture as the daemon pipeline). */
  relevanceClassifier?: RelevanceClassifier;
  /** Optional router classifier. When set alongside `skillRegistry`
   *  with size > 0 AND the utterance is tool-shaped, classify the
   *  utterance and dispatch the chosen skill in parallel with embed
   *  + retrieve. The skill's result becomes source[0] in the
   *  synthesizer's sources array. */
  classifier?: Classifier;
  /** Optional skill registry. See `classifier` above — both must be
   *  present (and registry non-empty) for the router branch to fire. */
  skillRegistry?: SkillRegistry;
  /** Snapshot of the rolling summary at call-fire time. Provides:
   *   - classifier context (current_topic + open_questions)
   *   - embedding-query key_terms boost (env-gated)
   *   - synthesizer recentContext (summary prose at head)
   *  Captured atomically by the caller (handleMessage) so an in-flight
   *  refresh cannot torn-read this value mid-pipeline. */
  lastSummary?: MeetingSummary;
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}): Promise<{ emitted: number; skipped?: string }> {
  args.runtime.recentFinals.push(args.utteranceText);
  while (args.runtime.recentFinals.length > WINDOW_UTTERANCES) {
    args.runtime.recentFinals.shift();
  }
  args.runtime.utteranceCountSinceLastRetrieval += 1;

  const now = Date.now();
  if (args.runtime.utteranceCountSinceLastRetrieval < UTTERANCE_THRESHOLD) {
    return { emitted: 0, skipped: 'below_utterance_threshold' };
  }
  if (now - args.runtime.lastRetrievalAt < COOLDOWN_MS) {
    return { emitted: 0, skipped: 'cooldown' };
  }

  args.runtime.utteranceCountSinceLastRetrieval = 0;
  args.runtime.lastRetrievalAt = now;

  const queryText = args.runtime.recentFinals.join(' ').trim();
  if (queryText.length === 0) return { emitted: 0, skipped: 'empty_query' };

  // ── Router gate ────────────────────────────────────────────────────
  // Heuristic-gated classifier. Fire in parallel with embed + retrieve
  // when (a) the latest utterance is tool-shaped, (b) classifier +
  // registry are configured, and (c) at least one skill is registered.
  // The classifier promise is awaited AFTER cards emit so TTFT on the
  // live page is unchanged regardless of classifier latency.
  let classifierPromise: ReturnType<Classifier['classify']> | null = null;
  let classifierController: AbortController | null = null;
  let classifierTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let classifierStartedAt = 0;
  const routerEligible =
    args.classifier !== undefined &&
    args.skillRegistry !== undefined &&
    args.skillRegistry.size() > 0 &&
    isToolShaped(args.utteranceText);
  if (routerEligible) {
    classifierController = new AbortController();
    classifierTimeoutHandle = setTimeout(
      () => classifierController?.abort(),
      RELEVANCE_TIMEOUT_MS,
    );
    classifierStartedAt = Date.now();
    const hasContext =
      args.lastSummary !== undefined &&
      ((args.lastSummary.current_topic?.length ?? 0) > 0 ||
        args.lastSummary.open_questions.length > 0);
    args.logger.info(
      {
        meetingId: args.meetingId,
        utteranceId: args.utteranceId,
        hadContext: hasContext,
      },
      'classifier.start',
    );
    classifierPromise = args.classifier!.classify(
      {
        utterance: args.utteranceText,
        registry: args.skillRegistry!,
        ...(hasContext && {
          context: {
            current_topic: args.lastSummary!.current_topic,
            open_questions: args.lastSummary!.open_questions,
          },
        }),
      },
      classifierController.signal,
    );
    // Swallow unhandled-rejection noise; the await later collects it.
    classifierPromise.catch(() => undefined);
  }

  // Optional key_terms boost: append project nouns the rolling summary
  // extracted so short follow-up utterances ("about that auth flow")
  // carry the topic vocabulary into the embedding. Env-gated default-off
  // because keyword-stuffing can degrade Voyage similarity on
  // natural-sentence input. See KEY_TERMS_BOOST_ENABLED comment.
  const keyTermsBoost =
    KEY_TERMS_BOOST_ENABLED &&
    args.lastSummary !== undefined &&
    args.lastSummary.key_terms.length > 0
      ? ` ${args.lastSummary.key_terms.join(' ')}`
      : '';
  const embedQueryText = queryText + keyTermsBoost;

  // Embed the rolling-window text as the query. Use text-domain so
  // we hit voyage-3-large (matching the prose chunks of the indexed
  // corpus). Code-chunk recall via prose queries is the cross-space
  // limitation called out in the /debug/ask page — same caveat applies.
  let queryEmbedding: Float32Array;
  try {
    const result = await args.embedder.embed({
      items: [{ text: embedQueryText, domain: 'text' }],
    });
    const vec = result.vectors[0]?.vector;
    if (vec === undefined) {
      return { emitted: 0, skipped: 'embed_no_vector' };
    }
    queryEmbedding = vec;
  } catch (err) {
    args.logger.warn({ err, meetingId: args.meetingId }, 'retrieval.embed.failed');
    return { emitted: 0, skipped: 'embed_failed' };
  }

  const queryLiteral = `[${Array.from(queryEmbedding).join(',')}]`;
  // Hybrid: dense (vector) + lexical (FTS) fused with RRF, gated by a
  // relevance floor. The lexical leg anchors specific-noun queries ("what
  // ai models") on the chunks that literally mention them, which pure
  // vector search missed; the floor drops weak-tail noise.
  const reranker = optionalReranker();
  let hits = await hybridSearch(args.db, {
    orgId: args.orgId,
    queryVectorLiteral: queryLiteral,
    queryText: queryText,
    limit: TOP_K,
    reranker,
    logger: args.logger,
  });

  // CRAG expansion (U9), gated by adaptive routing (U10 close-out): fire when
  // the first pass MISSED (zero hits) OR came back WEAK (no lexically-grounded
  // or close-vector hit — `isLowConfidenceHits`), and the query is substantive
  // enough to be worth it. Ask Claude for candidate terms, augment the query,
  // and re-retrieve once (bounded to a single retry). Escalating weak
  // retrievals — not just empty ones — is the real value of adaptive routing;
  // a scattered query that pulled one mediocre chunk now gets the richer path.
  const missed = hits.length === 0;
  const weak = !missed && isLowConfidenceHits(hits);
  if (missed || weak) {
    const expander = optionalQueryExpander();
    if (expander !== undefined && shouldExpandOnMiss(queryText)) {
      try {
        const terms = await expander(queryText);
        const augmented = augmentQuery(queryText, terms);
        if (augmented !== queryText) {
          const expandedEmbed = await args.embedder.embed({ items: [{ text: augmented, domain: 'text' }] });
          const expandedVec = expandedEmbed.vectors[0]?.vector;
          if (expandedVec !== undefined) {
            const expandedHits = await hybridSearch(args.db, {
              orgId: args.orgId,
              queryVectorLiteral: `[${Array.from(expandedVec).join(',')}]`,
              queryText: augmented,
              limit: TOP_K,
              reranker,
              logger: args.logger,
            });
            // On a true miss, any expanded hits are an improvement. On a weak
            // first pass we already have grounded (if mediocre) hits, so only
            // adopt the expansion when it comes back confident — never trade a
            // grounded result for a weaker one.
            const adopt = missed ? expandedHits.length > 0 : !isLowConfidenceHits(expandedHits);
            if (adopt) hits = expandedHits;
            args.logger.info(
              {
                meetingId: args.meetingId,
                reason: missed ? 'miss' : 'low_confidence',
                termCount: terms.length,
                hits: expandedHits.length,
                adopted: adopt,
              },
              'retrieval.crag.expanded',
            );
          }
        }
      } catch (err) {
        args.logger.warn({ err, meetingId: args.meetingId }, 'retrieval.crag.failed');
      }
    }
  }

  if (hits.length === 0) {
    return { emitted: 0, skipped: 'no_hits' };
  }

  // Fetch chunk + doc metadata in two more round-trips (mirrors the
  // /debug/ask page's enrichment shape).
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await args.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, domain, text, position, is_summary')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        doc_id: c.doc_id as string,
        domain: c.domain as string,
        text: c.text as string,
        position: c.position as number,
        isSummary: c.is_summary === true,
      },
    ]),
  );
  const docIds = Array.from(new Set(Array.from(chunkById.values()).map((c) => c.doc_id)));
  const { data: docRows } = await args.db
    .from('docs')
    .select('id, source, type, title, url')
    .in('id', docIds);
  const docById = new Map(
    (docRows ?? []).map((d) => [
      d.id as string,
      {
        source: d.source as string,
        type: d.type as string,
        title: d.title as string,
        url: (d.url as string | null) ?? null,
      },
    ]),
  );

  // Parent-document retrieval (U8): collapse multiple retrieved chunks of one
  // document to a single best-ranked source, then expand that survivor to its
  // surrounding parent context. The expanded text becomes BOTH the card body
  // and the synthesis source text, so the verbatim quote the model emits is
  // findable for citation verification AND for the live-page highlight (they
  // search the same substrate). One card per document; the card's identity
  // still points at the best child's doc. No-op (raw per-chunk hits, child
  // text) when the flag is off.
  const sourceHits = parentDocEnabled()
    ? dedupeByDoc(hits, (h) => chunkById.get(h.chunk_id)?.doc_id)
    : hits;
  const winners: WinningChunk[] = sourceHits.flatMap((h) => {
    const c = chunkById.get(h.chunk_id);
    return c === undefined ? [] : [{ chunkId: h.chunk_id, docId: c.doc_id, position: c.position, text: c.text }];
  });
  const expandedByChunk = parentDocEnabled()
    ? await expandWinnersToParents(args.db, winners)
    : new Map<string, string>();

  const traceId = randomUUID();
  let emitted = 0;
  const surfacedCardIds: string[] = [];
  const synthesisSources: SynthesisSource[] = [];
  for (let i = 0; i < sourceHits.length; i += 1) {
    const hit = sourceHits[i]!;
    const chunk = chunkById.get(hit.chunk_id);
    if (chunk === undefined) continue;
    const doc = docById.get(chunk.doc_id);
    if (doc === undefined) continue;

    // Persist the card row (RLS-scoped by org_id; insert via service
    // role) BEFORE the broadcast, per R23a.
    const cardId = `card_${randomUUID()}`;
    // The matched excerpt (focus). When U8 expanded a SUMMARY chunk to body
    // chunks, the summary isn't in `expanded`; prepend it so the card body
    // contains what the model quoted (citation highlights land) and flag the
    // card as a summary so the reader knows it's a condensed view of the doc.
    const expanded = expandedByChunk.get(hit.chunk_id) ?? chunk.text;
    const body = expanded.includes(chunk.text) ? expanded : `${chunk.text}\n\n${expanded}`;
    const isSummary = chunk.isSummary;
    const snippet = body.length > 400 ? body.slice(0, 400) + '…' : body;
    // cosine distance is in [0, 2]; convert to a [0, 1] similarity-ish
    // score so the HUD's score field aligns with what the HUD currently
    // expects (the daemon emits cosine similarity). FTS-only hits have no
    // vector distance; show a neutral mid score (they're lexically grounded
    // and ranked by RRF, just not by cosine proximity).
    const score = hit.distance !== null ? clamp01(1 - hit.distance / 2) : 0.5;

    const { error: cardErr } = await args.db.from('cards').insert({
      card_id: cardId,
      meeting_id: args.meetingId,
      org_id: args.orgId,
      doc_id: chunk.doc_id,
      source: doc.source,
      type: doc.type,
      title: doc.title,
      snippet,
      body,
      score,
      rank: i,
      metadata: { distance: hit.distance, chunkPosition: chunk.position, isSummary },
      surfaced_at: new Date().toISOString(),
      triggered_by: 'window',
      utterance_id: args.utteranceId,
      trace_id: traceId,
      url: doc.url,
    });
    if (cardErr !== null) {
      args.logger.warn({ err: cardErr, cardId }, 'retrieval.card.insert.failed');
      continue;
    }

    // Broadcast in the shape the live page's reducer expects (matches
    // @risezome/hud-ui's CardEvent).
    const cardPayload: CardPayload = {
      cardId,
      docId: chunk.doc_id,
      source: doc.source,
      type: doc.type,
      title: doc.title,
      snippet,
      body,
      score,
      rank: i,
      isSummary,
      metadata: { distance: hit.distance, chunkPosition: chunk.position, isSummary },
      surfacedAt: Date.now(),
      triggeredBy: 'window',
      utteranceId: args.utteranceId,
      traceId,
      ...(doc.url !== null ? { url: doc.url } : {}),
    };

    await persistAndBroadcast(args.db, {
      meetingId: args.meetingId,
      orgId: args.orgId,
      type: 'card',
      payload: { card: cardPayload },
    });

    // Stale-score retraction: if we already surfaced a card for this
    // docId, retract the old one so the stream doesn't show the same
    // chunk twice. Pinned cards are NEVER retracted by this path —
    // the user explicitly pulled them out of the firehose. We check
    // the DB row's pinned flag before retracting.
    const priorCardId = args.runtime.liveCardByDocId.get(chunk.doc_id);
    if (priorCardId !== undefined && priorCardId !== cardId) {
      await retractIfNotPinned(args.db, priorCardId, args.orgId, args.meetingId, args.logger);
    }
    args.runtime.liveCardByDocId.set(chunk.doc_id, cardId);

    surfacedCardIds.push(cardId);
    synthesisSources.push({
      rank: i + 1, // synthesizer expects 1-indexed
      text: expanded, // U8 expanded parent context (the summary excerpt is `focus`)
      // U8: judge relevance from the tight child that matched; formulate from
      // the expanded `text`. Equal to `text` when expansion was a no-op.
      focus: chunk.text,
      // docId lets citation verification accept a quote that's verbatim in a
      // sibling chunk of the same document surfaced at another rank.
      docId: chunk.doc_id,
      title: doc.title,
    });
    emitted += 1;
  }

  // ── Collect classifier result + execute skill (if router fired) ────
  // Cards have already shipped; this can take its time without
  // blocking TTFT. On `intent: 'tool'`, look up the skill, run its
  // handler with a SkillContext keyed to this org, and format the
  // result as a SynthesisSource. The synthesizer call below prepends
  // this source at sources[0] (cited as [1]) when present.
  let toolSource: SynthesisSource | null = null;
  if (classifierPromise !== null) {
    if (classifierTimeoutHandle !== null) clearTimeout(classifierTimeoutHandle);
    try {
      const result = await classifierPromise;
      args.logger.info(
        {
          meetingId: args.meetingId,
          utteranceId: args.utteranceId,
          intent: result.intent,
          ...(result.intent === 'tool' && { skillName: result.skillName }),
          latencyMs: Date.now() - classifierStartedAt,
        },
        'classifier.done',
      );
      if (result.intent === 'tool') {
        const skill: Skill | undefined = args.skillRegistry!.lookup(result.skillName);
        if (skill === undefined) {
          args.logger.warn(
            {
              meetingId: args.meetingId,
              utteranceId: args.utteranceId,
              skillName: result.skillName,
              code: 'unknown-skill',
            },
            'skill.failed',
          );
        } else {
          const skillStartedAt = Date.now();
          args.logger.info(
            {
              meetingId: args.meetingId,
              utteranceId: args.utteranceId,
              skillName: result.skillName,
              args: result.args,
            },
            'skill.start',
          );
          try {
            const skillContext: SkillContext = {
              db: args.db,
              orgId: args.orgId,
              ...(classifierController !== null && { signal: classifierController.signal }),
            };
            const skillResult = await skill.handler(result.args, skillContext);
            args.logger.info(
              {
                meetingId: args.meetingId,
                utteranceId: args.utteranceId,
                skillName: result.skillName,
                latencyMs: Date.now() - skillStartedAt,
                resultShape: skillResult.kind,
              },
              'skill.done',
            );
            // Router safety-net (U4): a self-healed result the skill marked
            // 'unresolved' (KTD8 — misparse left the query unscoped, or a
            // validation fetch failed) is dropped so synthesis falls back to
            // RAG. This decision is made HERE, before synthesis is invoked, so
            // a dropped result never emits a premature synthesisStart (KTD7).
            const decision = decideToolSource(skillResult);
            // Build the tool source (the answer-affecting step) BEFORE the
            // telemetry log, so a logger throw can't drop a valid result into
            // the catch and misreport it as skill.failed.
            if (decision.keep) {
              toolSource = formatAsSource(skillResult, result.skillName, result.args);
            }
            if (decision.status !== 'clean') {
              args.logger.warn(
                {
                  meetingId: args.meetingId,
                  utteranceId: args.utteranceId,
                  skillName: result.skillName,
                  status: decision.status,
                  ...(skillResult.recovery?.neutralized !== undefined && {
                    neutralized: skillResult.recovery.neutralized,
                  }),
                },
                'skill.suspect',
              );
            }
          } catch (err) {
            const code =
              err instanceof SkillExecutionError ? err.executionCode : 'execution-error';
            args.logger.warn(
              {
                meetingId: args.meetingId,
                utteranceId: args.utteranceId,
                skillName: result.skillName,
                code,
                message: (err as Error).message,
              },
              'skill.failed',
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof ClassifierProviderError) {
        args.logger.warn(
          { meetingId: args.meetingId, code: err.kind, message: err.message },
          'classifier.error',
        );
      } else if (err instanceof Error && err.name === 'AbortError') {
        // Aborted by timeout — silent.
      } else {
        args.logger.warn(
          { meetingId: args.meetingId, message: (err as Error).message },
          'classifier.error',
        );
      }
    }
  }

  // ── Synthesis ─────────────────────────────────────────────────────
  // After cards are emitted, kick off Anthropic synthesis across them.
  // Streams the result back as batched synthesisDelta broadcasts so the
  // live page's right panel populates as tokens arrive. Fire-and-forget
  // from the caller's perspective — we don't block the retrieval-tick
  // return on synthesis completion.
  //
  // Synthesis fires when EITHER we have RAG sources OR we have a tool
  // source. The tool-only path (no cards but classifier answered)
  // bypasses the cards-needed gate so a structured question whose
  // retrieval found nothing still gets framed by the synthesizer.
  if (args.synthesizer !== undefined && (synthesisSources.length > 0 || toolSource !== null)) {
    // Two-stage relevance gate:
    //   1. Cheap regex heuristic on the latest final utterance.
    //      clearly_filler short-circuits with zero API cost.
    //   2. If heuristic returns `ambiguous` and the LLM classifier is
    //      available, ask the LLM. `skip` with confidence > threshold
    //      means we don't synthesize (transparent quality + cost
    //      improvement on stuff like "so anyway, that's where we are").
    //      `surface` or any classifier error falls through to synthesis
    //      (fail-open).
    const heuristic = classifyRelevanceHeuristic(args.utteranceText);
    if (heuristic === 'clearly_filler') {
      args.logger.info(
        { meetingId: args.meetingId, utteranceId: args.utteranceId, relevance: heuristic },
        'synthesis.skipped.filler',
      );
    } else {
      const shouldSkip = heuristic === 'ambiguous' && args.relevanceClassifier !== undefined
        ? await classifyLlmAndDecide({
            classifier: args.relevanceClassifier,
            utterance: args.utteranceText,
            meetingId: args.meetingId,
            utteranceId: args.utteranceId,
            ...(args.lastSummary !== undefined && {
              context: {
                current_topic: args.lastSummary.current_topic,
                open_questions: args.lastSummary.open_questions,
              },
            }),
            logger: args.logger,
          })
        : false;
      if (shouldSkip) {
        // Already logged inside classifyLlmAndDecide.
      } else {
        // recentContext for the synthesizer: rolling summary prose at
        // head (oldest = longest-range topic context), then recent
        // finals excluding the current utterance (which IS the query
        // arg). Mirrors the debug-path construction so both pipelines
        // give the synthesizer the same long-range memory.
        const recentContext: string[] = [];
        if (args.lastSummary !== undefined && args.lastSummary.summary.length > 0) {
          recentContext.push(args.lastSummary.summary);
        }
        for (const finalText of args.runtime.recentFinals.slice(0, -1)) {
          recentContext.push(finalText);
        }
        // Tool result, when present, takes source[0]; cards follow at
        // [1..N]. The synthesizer's prompt cites by 1-indexed array
        // position, so [1] is the tool and [2..N] are the cards.
        const mergedSources = mergeToolSource(toolSource, synthesisSources);
        void runSynthesisAndBroadcast({
          synthesizer: args.synthesizer,
          utterance: queryText,
          sources: mergedSources,
          surfacedCardIds,
          utteranceId: args.utteranceId,
          traceId,
          meetingId: args.meetingId,
          orgId: args.orgId,
          db: args.db,
          ...(recentContext.length > 0 && { recentContext }),
          ...(args.onGroundedAnswer !== undefined && { onGroundedAnswer: args.onGroundedAnswer }),
          logger: args.logger,
        });
      }
    }
  }

  args.logger.info(
    {
      meetingId: args.meetingId,
      hits: hits.length,
      emitted,
      cooldownUntil: now + COOLDOWN_MS,
    },
    'retrieval.complete',
  );
  return { emitted };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Mark a prior card as retracted (verifier-downgraded) unless it's
 * been pinned by the user. Broadcasts cardRetracted so live page
 * subscribers remove it from the stream immediately. Best-effort — a
 * failed retract leaves the duplicate visible but doesn't break the
 * new card path.
 */
async function retractIfNotPinned(
  db: SupabaseClient,
  cardId: string,
  orgId: string,
  meetingId: string,
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void },
): Promise<void> {
  const { data: priorRow } = await db
    .from('cards')
    .select('pinned')
    .eq('card_id', cardId)
    .maybeSingle();
  if (priorRow === null) return;
  if (priorRow.pinned === true) return; // pinned cards are sacred

  const { error: updateErr } = await db
    .from('cards')
    .update({
      retracted_at: new Date().toISOString(),
      retracted_reason: 'verifier-downgraded',
    })
    .eq('card_id', cardId)
    .is('retracted_at', null);
  if (updateErr !== null) {
    logger.warn({ err: updateErr, cardId }, 'retraction.update.failed');
    return;
  }

  await persistAndBroadcast(db, {
    meetingId,
    orgId,
    type: 'cardRetracted',
    payload: {
      retracted: { cardId, reason: 'verifier-downgraded' },
    },
  });
  logger.info({ cardId, meetingId }, 'card.retracted.verifier-downgraded');
}

/**
 * Threshold a `skip` decision must clear before we honor it. Below this,
 * we treat the result as `surface` and synthesize anyway. Mirrors the
 * daemon's RISEZOME_RELEVANCE_SKIP_THRESHOLD default. Configurable via
 * env later if telemetry shows tuning is needed.
 */
const RELEVANCE_SKIP_THRESHOLD = 0.7;
const RELEVANCE_TIMEOUT_MS = 3000;

/**
 * Run the LLM classifier on an ambiguous utterance, with a hard timeout
 * so a slow Anthropic response can't stall the retrieval loop. Returns
 * true when synthesis should be skipped, false otherwise. Any error
 * (timeout, auth, 5xx) falls through to false (fail-open).
 */
async function classifyLlmAndDecide(args: {
  classifier: RelevanceClassifier;
  utterance: string;
  meetingId: string;
  utteranceId: string;
  /** Optional meeting context for coherence-in-context judgment. When
   *  present, a short fragment that looks like filler in isolation can
   *  still surface as a coherent continuation of an open topic. */
  context?: {
    readonly current_topic?: string;
    readonly open_questions?: readonly string[];
  };
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}): Promise<boolean> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), RELEVANCE_TIMEOUT_MS);
  try {
    const result = await args.classifier.classify(args.utterance, {
      signal: controller.signal,
      ...(args.context !== undefined && { context: args.context }),
    });
    if (result.decision === 'skip' && result.confidence >= RELEVANCE_SKIP_THRESHOLD) {
      args.logger.info(
        {
          meetingId: args.meetingId,
          utteranceId: args.utteranceId,
          confidence: result.confidence,
          reason: result.reason,
          hadContext: args.context !== undefined,
        },
        'synthesis.skipped.llm',
      );
      return true;
    }
    return false;
  } catch (err) {
    args.logger.warn(
      { err, meetingId: args.meetingId, utteranceId: args.utteranceId },
      'relevance.llm.failed',
    );
    return false;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

const SYNTHESIS_MAX_TOKENS = 150;

/**
 * Drive a single synthesis run end-to-end:
 *   1. Broadcast `synthesisStart` (synthesisId + source card ids)
 *   2. Consume the synthesizer's AsyncIterable
 *   3. Buffer textDelta tokens; flush a batched broadcast every 250ms
 *      (and once on done) — keeps the broadcast volume sane while still
 *      feeling streaming
 *   4. On done: broadcast `synthesisDone` with stop reason + usage
 *   5. On error: broadcast `synthesisError` with a code + message
 *
 * Each event also writes a row to syntheses (for the start) or updates
 * the row (accumulated_text, status, citations, usage) so reconnect-fetch
 * can rebuild the synthesis state from DB alone.
 *
 * Errors are swallowed at the boundary — synthesis failure is best-effort,
 * cards on their own are still useful. We log + emit a synthesisError
 * event and exit.
 */
async function runSynthesisAndBroadcast(args: {
  synthesizer: Synthesizer;
  utterance: string;
  sources: SynthesisSource[];
  surfacedCardIds: string[];
  /** The transcript utterance that triggered this synthesis — anchors the
   *  synthesis to its spot in the transcript on the review page (U6). */
  utteranceId: string;
  traceId: string;
  meetingId: string;
  orgId: string;
  db: SupabaseClient;
  /** Oldest-first prior context for pronoun + fragment resolution.
   *  Head entry is the rolling-summary prose (long-range memory);
   *  remainder are recent finals (short-range). */
  recentContext?: readonly string[];
  /** Close-the-loop: invoked with the grounded answer body on success. */
  onGroundedAnswer?: (text: string) => void;
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}): Promise<void> {
  const synthesisId = `synth_${randomUUID()}`;
  let accumulated = '';
  let startUsage: SynthesisUsage | null = null;
  const startedAt = Date.now();

  // syntheses row keyed by synthesis_id; inserted as `running` so a reconnect
  // can rebuild from the DB. Flash fix: we do NOT broadcast synthesisStart or
  // synthesisDelta while streaming. grounded-or-nothing can't be decided until
  // `done`, and streaming a body that's then retracted on an ungrounded/refused
  // answer flashes text that vanishes on the live page. Buffer here; reveal the
  // whole answer at once on `done`, and only when it grounds. (Mirrors the
  // debug path. A prior grounded answer therefore survives subsequent filler
  // instead of being wiped by a start-then-retract.)
  const insertResult = await args.db.from('syntheses').insert({
    synthesis_id: synthesisId,
    meeting_id: args.meetingId,
    org_id: args.orgId,
    source_card_ids: args.surfacedCardIds,
    accumulated_text: '',
    status: 'running',
    citations: [],
    trace_id: args.traceId,
    trigger_utterance_id: args.utteranceId,
  });
  if (insertResult.error !== null) {
    args.logger.warn({ err: insertResult.error, synthesisId }, 'synthesis.insert.failed');
    return;
  }

  try {
    for await (const chunk of args.synthesizer.synthesize({
      utterance: args.utterance,
      sources: args.sources,
      maxTokens: SYNTHESIS_MAX_TOKENS,
      ...(args.recentContext !== undefined && args.recentContext.length > 0
        ? { recentContext: args.recentContext }
        : {}),
    })) {
      if (chunk.type === 'start') {
        startUsage = chunk.usage;
      } else if (chunk.type === 'textDelta') {
        // Buffer only (see the flash-fix note above): accumulate so we can
        // parse + verify citations on `done`; nothing is streamed mid-flight.
        accumulated += chunk.delta;
      } else if (chunk.type === 'done') {
        const latencyMs = Date.now() - startedAt;
        const parsed = parseSynthesisOutput(accumulated, args.sources.length);

        if (parsed.isRefusal) {
          // The model emitted "No relevant context." — surface as a
          // retraction so the right panel collapses gracefully instead
          // of showing the literal refusal text. The cards on the left
          // still stand.
          await args.db
            .from('syntheses')
            .update({
              status: 'retracted',
              retracted_at: new Date().toISOString(),
              retracted_reason: 'refusal',
              stop_reason: chunk.stopReason,
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
              cache_read_tokens: chunk.usage.cacheReadTokens,
              cache_creation_tokens: chunk.usage.cacheCreationTokens,
              latency_ms: latencyMs,
            })
            .eq('synthesis_id', synthesisId);

          await persistAndBroadcast(args.db, {
            meetingId: args.meetingId,
            orgId: args.orgId,
            type: 'synthesisRetracted',
            payload: {
              retracted: {
                synthesisId,
                reason: 'source-retracted',
              },
            },
          });

          args.logger.info(
            { synthesisId, meetingId: args.meetingId, latencyMs },
            'synthesis.refusal',
          );
          return;
        }

        // U2: rich per-occurrence citation shape on the wire + in storage.
        // Map rank → cardId via the synthesis's surfacedCardIds (1-based
        // rank, 0-based index). Drop entries with no resolvable cardId
        // (shouldn't happen because the parser already bounds rank to
        // sources.length, but defensive belt-and-suspenders).
        // Drop fabricated quoted citations (quote not present in the cited
        // source) before mapping to cardIds — grounding safety net.
        const { verified, droppedQuoted, downgradedToBare } = verifyCitations(parsed.citations, args.sources);
        if (droppedQuoted > 0 || downgradedToBare > 0) {
          args.logger.warn(
            { synthesisId, meetingId: args.meetingId, droppedQuoted, downgradedToBare },
            'synthesis.citations.dropped-unverified',
          );
        }
        const richCitations = verified.flatMap((c) => {
          const cardId = args.surfacedCardIds[c.rank - 1];
          if (cardId === undefined) return [];
          return [
            {
              rank: c.rank,
              cardId,
              position: c.position,
              ...(c.quote !== undefined ? { quote: c.quote } : {}),
            },
          ];
        });
        const quoteCount = richCitations.reduce(
          (n, c) => ('quote' in c && c.quote.length > 0 ? n + 1 : n),
          0,
        );
        const quoteCharsTotal = richCitations.reduce(
          (n, c) => n + ('quote' in c ? c.quote.length : 0),
          0,
        );

        // Grounded-or-nothing: an answer with no surviving citation is not
        // grounded in the retrieved sources (the model cited nothing, or
        // every quote failed verification). Suppress it like a refusal
        // rather than render a confident, unsourced paragraph.
        if (richCitations.length === 0) {
          await args.db
            .from('syntheses')
            .update({
              status: 'retracted',
              retracted_at: new Date().toISOString(),
              retracted_reason: 'ungrounded',
              stop_reason: chunk.stopReason,
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
              cache_read_tokens: chunk.usage.cacheReadTokens,
              cache_creation_tokens: chunk.usage.cacheCreationTokens,
              latency_ms: latencyMs,
            })
            .eq('synthesis_id', synthesisId);
          await persistAndBroadcast(args.db, {
            meetingId: args.meetingId,
            orgId: args.orgId,
            type: 'synthesisRetracted',
            payload: { retracted: { synthesisId, reason: 'source-retracted' } },
          });
          args.logger.info(
            { synthesisId, meetingId: args.meetingId, latencyMs, droppedQuoted },
            'synthesis.ungrounded',
          );
          return;
        }

        await args.db
          .from('syntheses')
          .update({
            status: 'done',
            accumulated_text: parsed.text,
            stop_reason: chunk.stopReason,
            citations: richCitations,
            input_tokens: chunk.usage.inputTokens,
            output_tokens: chunk.usage.outputTokens,
            cache_read_tokens: chunk.usage.cacheReadTokens,
            cache_creation_tokens: chunk.usage.cacheCreationTokens,
            latency_ms: latencyMs,
          })
          .eq('synthesis_id', synthesisId);

        // Grounded: reveal the whole answer in one shot — start, a single full
        // delta, then done — so a complete, cited synthesis appears at once
        // with no optimistic-then-retracted flash.
        await persistAndBroadcast(args.db, {
          meetingId: args.meetingId,
          orgId: args.orgId,
          type: 'synthesisStart',
          payload: { start: { synthesisId, sourceCardIds: args.surfacedCardIds, traceId: args.traceId } },
        });
        await persistAndBroadcast(args.db, {
          meetingId: args.meetingId,
          orgId: args.orgId,
          type: 'synthesisDelta',
          payload: { delta: { synthesisId, delta: parsed.text } },
        });
        await persistAndBroadcast(args.db, {
          meetingId: args.meetingId,
          orgId: args.orgId,
          type: 'synthesisDone',
          payload: {
            done: {
              synthesisId,
              stopReason: chunk.stopReason,
              citations: richCitations,
              usage: chunk.usage,
              ttftMs: 0, // Not currently measured at this layer.
              latencyMs,
            },
          },
        });

        // Close the loop: the grounded answer was shown on-screen but never
        // spoken, so hand it to the summarizer to retire the open question it
        // resolved (otherwise that question keeps re-driving synthesis).
        args.onGroundedAnswer?.(parsed.text);

        args.logger.info(
          {
            synthesisId,
            meetingId: args.meetingId,
            latencyMs,
            outputTokens: chunk.usage.outputTokens,
            citationTotal: richCitations.length,
            citationWithQuote: quoteCount,
            quoteCharsTotal,
          },
          'synthesis.done',
        );
        return;
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = (err as { kind?: string }).kind ?? 'unknown';
    args.logger.warn({ err, synthesisId, meetingId: args.meetingId }, 'synthesis.failed');

    await args.db
      .from('syntheses')
      .update({
        status: 'errored',
        error_code: errorCode,
        error_message: errorMessage,
      })
      .eq('synthesis_id', synthesisId);

    await persistAndBroadcast(args.db, {
      meetingId: args.meetingId,
      orgId: args.orgId,
      type: 'synthesisError',
      payload: {
        error: {
          synthesisId,
          code: errorCode,
          message: errorMessage,
        },
      },
    });
  }
  // Use startUsage to silence "assigned but never used" if synthesis
  // ended without a done event (shouldn't happen for well-behaved
  // synthesizers, but keep the lint happy).
  void startUsage;
}
