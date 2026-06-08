// Shared, sink-agnostic retrieval/synthesis pipeline core (U1).
//
// `runPipeline` runs the ordered stages lifted from
// `apps/bot-worker/src/retrieval.ts`'s `maybeRetrieveAndEmit`, with the
// divergences resolved to canonical behavior:
//
//   pre-retrieval gate (KTD3: heuristic → judge, BEFORE embed)
//     → embed → hybrid search (canonical topK)
//     → CRAG expansion on miss/weak (bounded to one retry)
//     → 0 hits ⇒ recordMiss(no_hits) gated by the heuristic (filler is never a gap)
//     → chunk/doc enrichment → dedupeByDoc + expandWinnersToParents
//     → emitCard per surviving doc
//     → synthesis (parse + verify; grounded-or-nothing) → done / refusal / ungrounded
//
// The core imports NO transport: db access is via injected `PipelineDeps`
// functions, results go out through the `PipelineSink`. The trace is OPTIONAL
// and ZERO-COST when absent: every trace block is guarded by
// `if (sink.recordTrace)` (KTD4/R5).

import { randomUUID } from 'node:crypto';
import { parseSynthesisOutput, verifyCitationsDetailed, stripStatusPrefix } from '@risezome/engine/synthesize';
import type { SynthesisSource, SynthesisUsage } from '@risezome/engine/synthesize';
import { classifyRelevanceHeuristic } from '@risezome/engine/relevance';
import type { RelevanceResult } from '@risezome/engine/relevance';
import { shouldRecordMiss } from '@risezome/engine/gaps';
import { augmentQuery } from '@risezome/engine/query-expand';
import { shouldExpandOnMiss } from '@risezome/engine/query-route';
import { isToolShaped, ClassifierProviderError } from '@risezome/engine/router';
import {
  type Skill,
  type SkillContext,
  SkillExecutionError,
  formatAsSource,
} from '@risezome/engine/skills';
import { decideToolSource, mergeToolSource } from '../retrieval-safety-net.js';
import type { WinningChunk } from '../parent-doc.js';
import type { HybridHit } from '../corpus-search.js';
import type {
  PipelineDeps,
  PipelineInput,
  PipelineSink,
  PipelineCard,
  StageRecord,
  PipelineStage,
  TraceHit,
} from './contract.js';

/** Canonical top-K (U1 resolution): prod used 3, dev/eval 5 — unified to 5
 *  (the broader recall the dev/eval already validated; precision is held by
 *  the relevance gate + the vector floor, not by a tight K). Overridable via
 *  `deps.topK`. */
const DEFAULT_TOP_K = 5;
const DEFAULT_RELEVANCE_SKIP_THRESHOLD = 0.7;
const RELEVANCE_TIMEOUT_MS = 3000;
const SYNTHESIS_MAX_TOKENS = 150;

/** Outcome of one `runPipeline` call (the same `{ emitted, skipped? }` the
 *  prod adapter's caller already consumes). */
export interface PipelineResult {
  readonly emitted: number;
  readonly skipped?: string;
}

/** Internal trace accumulator. Only instantiated when the sink can receive a
 *  trace (R5) — guarded at every call site via `tracing`. */
class TraceBuilder {
  readonly #stages: StageRecord[] = [];
  push(record: StageRecord): void {
    this.#stages.push(record);
  }
  stages(): readonly StageRecord[] {
    return this.#stages;
  }
}

function stageRecord(
  stage: PipelineStage,
  status: StageRecord['status'],
  startedAt: number,
  extra?: { decision?: string; reason?: string; data?: Record<string, unknown> },
): StageRecord {
  return {
    stage,
    status,
    latencyMs: Date.now() - startedAt,
    ...(extra?.decision !== undefined ? { decision: extra.decision } : {}),
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra?.data !== undefined ? { data: extra.data } : {}),
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Run the full retrieval/synthesis pipeline against ONE utterance, writing
 * every result through `sink`. Sink-agnostic and transport-free.
 */
export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  sink: PipelineSink,
): Promise<PipelineResult> {
  const traceId = randomUUID();
  const topK = deps.topK ?? DEFAULT_TOP_K;
  const skipThreshold = deps.relevanceSkipThreshold ?? DEFAULT_RELEVANCE_SKIP_THRESHOLD;
  const strict = deps.relevanceStrict === true;

  // Trace is OPTIONAL + zero-cost when absent (KTD4/R5): only build the
  // accumulator when the sink can receive it.
  const tracing = sink.recordTrace !== undefined;
  const trace = tracing ? new TraceBuilder() : null;
  const emitTrace = (): void => {
    if (trace !== null && sink.recordTrace !== undefined) {
      sink.recordTrace({
        traceId,
        utteranceId: input.utteranceId,
        meetingId: input.meetingId,
        // KTD6: the exact prior context this run saw (effective window
        // post-voiding, summary at head) — surfaced for replay inspection.
        priorContext: input.recentContext ?? [],
        stages: trace.stages(),
      });
    }
  };

  const emptyStart = Date.now();
  const queryText = input.queryText.trim();
  if (queryText.length === 0) {
    if (trace !== null) {
      trace.push(
        stageRecord('empty-query', 'short_circuited', emptyStart, {
          decision: 'skip',
          reason: 'empty_query',
        }),
      );
      emitTrace();
    }
    return { emitted: 0, skipped: 'empty_query' };
  }
  if (trace !== null) {
    trace.push(
      stageRecord('empty-query', 'ran', emptyStart, {
        decision: 'pass',
        data: { chars: queryText.length },
      }),
    );
  }

  // ── Stage: pre-retrieval relevance gate (KTD3) ────────────────────────
  // Heuristic first (zero-cost filler short-circuit), then route to the LLM
  // judge on `ambiguous` always — and on `clearly_substantive` too when strict
  // (U3 about-our-work routing). A skip stops BEFORE embed/search; the
  // utterance emits no cards.
  // QUESTION lane (KTD2): the adapter already classified this as a substantive
  // question, so SKIP the relevance gate entirely — retrieve and let the
  // synthesizer be the relevance backstop (ground-or-refuse). A cheap refusal is
  // the worst case; an answerable question is never dropped before retrieval.
  // lane undefined ⇒ ambient (back-compat for eval/legacy callers).
  const bypassGate = input.lane === 'question';
  const heuristicStart = Date.now();
  const heuristic = classifyRelevanceHeuristic(input.utteranceText);
  if (!bypassGate && heuristic === 'clearly_filler') {
    deps.logger.info(
      { meetingId: input.meetingId, utteranceId: input.utteranceId, relevance: heuristic },
      'pipeline.gate.filler',
    );
    sink.recordSkip({ stage: 'heuristic-gate', reason: 'filler' });
    if (trace !== null) {
      trace.push(
        stageRecord('heuristic-gate', 'short_circuited', heuristicStart, {
          decision: 'skip',
          reason: 'clearly_filler',
        }),
      );
      emitTrace();
    }
    return { emitted: 0, skipped: 'filler' };
  }
  if (trace !== null) {
    trace.push(
      stageRecord('heuristic-gate', bypassGate ? 'short_circuited' : 'ran', heuristicStart, {
        decision: bypassGate ? 'bypassed' : heuristic,
        reason: bypassGate
          ? 'question_lane'
          : heuristic === 'clearly_substantive'
            ? 'substantive'
            : 'ambiguous',
      }),
    );
  }

  const routeToJudge =
    !bypassGate &&
    (heuristic === 'ambiguous' || (strict && heuristic === 'clearly_substantive')) &&
    deps.relevanceClassifier !== undefined;
  // Fire the relevance judge CONCURRENTLY with embed + search (latency U2). Its
  // verdict is applied AFTER the search returns (below), so retrieval overlaps
  // the judge instead of waiting for it — latency becomes max(judge, retrieval).
  // On a filler verdict the speculative retrieval is discarded there (no cards,
  // no gap). Fail-open (timeout/error → surface) is preserved.
  const judgeStart = Date.now();
  let judgePromise: Promise<RelevanceResult> | null = null;
  if (routeToJudge && deps.relevanceClassifier !== undefined) {
    const context = relevanceContextFrom(input);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), RELEVANCE_TIMEOUT_MS);
    judgePromise = deps.relevanceClassifier
      .classify(input.utteranceText, {
        signal: controller.signal,
        ...(context !== undefined ? { context } : {}),
      })
      .catch((err): RelevanceResult => {
        deps.logger.warn(
          { err, meetingId: input.meetingId, utteranceId: input.utteranceId },
          'pipeline.gate.llm.failed',
        );
        return { decision: 'surface' }; // fail-open on classifier error
      })
      .finally(() => clearTimeout(timeoutHandle));
  } else if (trace !== null) {
    trace.push(
      stageRecord('llm-judge', 'skipped', judgeStart, {
        reason:
          deps.relevanceClassifier === undefined ? 'no_classifier' : 'not_routed',
      }),
    );
  }

  // ── Router stage (parallel skill dispatch) ────────────────────────────
  // Fire the tool classifier in parallel with embed + retrieve when configured
  // and the utterance is tool-shaped. Awaited AFTER cards emit (below) so it
  // never delays surfacing. Sink-agnostic: the resulting tool source rides into
  // synthesis at [0]; the sink decides how toolSource is surfaced.
  const routerEligible =
    deps.routerClassifier !== undefined &&
    deps.skillRegistry !== undefined &&
    deps.skillRegistry.size() > 0 &&
    isToolShaped(input.utteranceText);
  let classifierController: AbortController | null = null;
  let classifierPromise: ReturnType<
    NonNullable<PipelineDeps['routerClassifier']>['classify']
  > | null = null;
  if (routerEligible && deps.routerClassifier !== undefined && deps.skillRegistry !== undefined) {
    classifierController = new AbortController();
    setTimeout(() => classifierController?.abort(), RELEVANCE_TIMEOUT_MS);
    const summary = input.lastSummary;
    const hasContext =
      summary !== undefined &&
      ((summary.current_topic?.length ?? 0) > 0 || summary.open_questions.length > 0);
    classifierPromise = deps.routerClassifier.classify(
      {
        utterance: input.utteranceText,
        registry: deps.skillRegistry,
        ...(hasContext && summary !== undefined
          ? {
              context: {
                current_topic: summary.current_topic,
                open_questions: summary.open_questions,
              },
            }
          : {}),
      },
      classifierController.signal,
    );
    classifierPromise.catch(() => undefined); // collected on await below
  }
  if (trace !== null) {
    trace.push(
      stageRecord('router', 'ran', Date.now(), {
        decision: routerEligible ? 'fired' : 'not_fired',
        reason: routerEligible
          ? 'tool_shaped — classifying in parallel'
          : deps.routerClassifier === undefined || deps.skillRegistry === undefined
            ? 'no_classifier_or_registry'
            : deps.skillRegistry.size() === 0
              ? 'empty_skill_registry'
              : 'not_tool_shaped',
      }),
    );
  }

  // ── Stage: embed ──────────────────────────────────────────────────────
  const embedStart = Date.now();
  let queryEmbedding: Float32Array;
  if (input.queryVector !== undefined) {
    // Latency U1: the question lane already embedded the query text (for
    // near-duplicate suppression) and threaded the vector here, so skip a
    // redundant second embed. The question lane applies no key_terms boost, so
    // this vector equals what we would have produced from `queryText`.
    queryEmbedding = Float32Array.from(input.queryVector);
    if (trace !== null) {
      trace.push(
        stageRecord('embed', 'ran', embedStart, {
          decision: 'reused',
          data: { dims: queryEmbedding.length, reused: true },
        }),
      );
    }
  } else {
    const embedQueryText = queryText + keyTermsBoost(input);
    try {
      const result = await deps.embedder.embed({ items: [{ text: embedQueryText, domain: 'text' }] });
      const vec = result.vectors[0]?.vector;
      if (vec === undefined) {
        if (trace !== null) {
          trace.push(
            stageRecord('embed', 'short_circuited', embedStart, { reason: 'no_vector' }),
          );
          emitTrace();
        }
        return { emitted: 0, skipped: 'embed_no_vector' };
      }
      queryEmbedding = vec;
    } catch (err) {
      deps.logger.warn({ err, meetingId: input.meetingId }, 'pipeline.embed.failed');
      if (trace !== null) {
        trace.push(stageRecord('embed', 'short_circuited', embedStart, { reason: 'embed_failed' }));
        emitTrace();
      }
      return { emitted: 0, skipped: 'embed_failed' };
    }
    if (trace !== null) {
      trace.push(stageRecord('embed', 'ran', embedStart, { data: { dims: queryEmbedding.length } }));
    }
  }

  // ── Stage: hybrid search ──────────────────────────────────────────────
  const searchStart = Date.now();
  const queryLiteral = `[${Array.from(queryEmbedding).join(',')}]`;
  const reranker = deps.optionalReranker();
  let hits = await deps.hybridSearch({
    orgId: input.orgId,
    queryVectorLiteral: queryLiteral,
    queryText,
    limit: topK,
    reranker,
    logger: deps.logger,
  });
  // The hybrid-search trace stage carries its OWN ranked hits (so a persisted/
  // after-the-fact trace is self-contained — the panel no longer has to splice
  // the separate `card` events back in). Built once we've enriched titles/
  // isSummary below; here we just freeze the search latency. Zero-cost when
  // untraced: the array + the per-hit push are all inside `trace !== null`.
  const searchLatencyMs = trace !== null ? Date.now() - searchStart : 0;

  // ── Resolve the relevance verdict (U2) ────────────────────────────────
  // The judge overlapped embed + search; gate on it now, BEFORE the expensive
  // CRAG / enrich / card-emit stages. Filler → discard the speculative
  // retrieval: no cards, no gap (identical to the pre-U2 early skip — the
  // no-hits/gap path below is never reached). Surface → continue.
  if (judgePromise !== null) {
    const decision = await judgePromise;
    if (decision.decision === 'skip' && decision.confidence >= skipThreshold) {
      deps.logger.info(
        {
          meetingId: input.meetingId,
          utteranceId: input.utteranceId,
          confidence: decision.confidence,
          reason: decision.reason,
        },
        'pipeline.gate.llm.skipped',
      );
      sink.recordSkip({
        stage: 'llm-judge',
        reason: decision.reason,
        confidence: decision.confidence,
      });
      if (trace !== null) {
        trace.push(
          stageRecord('llm-judge', 'short_circuited', judgeStart, {
            decision: 'skip',
            reason: decision.reason,
            data: { confidence: decision.confidence },
          }),
        );
        emitTrace();
      }
      return { emitted: 0, skipped: 'relevance_skip' };
    }
    if (trace !== null) {
      trace.push(
        stageRecord('llm-judge', 'ran', judgeStart, {
          decision: 'surface',
          ...(decision.decision === 'skip'
            ? { reason: `below_threshold(${String(decision.confidence)})` }
            : {}),
        }),
      );
    }
  }

  // ── Stage: CRAG expansion on miss/weak (bounded to one retry) ─────────
  const cragStart = Date.now();
  const missed = hits.length === 0;
  const weak = !missed && deps.isLowConfidenceHits(hits);
  let cragRan = false;
  let cragAdopted = false;
  if (missed || weak) {
    const expander = deps.optionalQueryExpander();
    if (expander !== undefined && shouldExpandOnMiss(queryText)) {
      cragRan = true;
      try {
        const terms = await expander(queryText);
        const augmented = augmentQuery(queryText, terms);
        if (augmented !== queryText) {
          const expandedEmbed = await deps.embedder.embed({
            items: [{ text: augmented, domain: 'text' }],
          });
          const expandedVec = expandedEmbed.vectors[0]?.vector;
          if (expandedVec !== undefined) {
            const expandedHits = await deps.hybridSearch({
              orgId: input.orgId,
              queryVectorLiteral: `[${Array.from(expandedVec).join(',')}]`,
              queryText: augmented,
              limit: topK,
              reranker,
              logger: deps.logger,
            });
            const adopt = missed
              ? expandedHits.length > 0
              : !deps.isLowConfidenceHits(expandedHits);
            if (adopt) {
              hits = expandedHits;
              cragAdopted = true;
            }
            deps.logger.info(
              {
                meetingId: input.meetingId,
                reason: missed ? 'miss' : 'low_confidence',
                termCount: terms.length,
                hits: expandedHits.length,
                adopted: adopt,
              },
              'pipeline.crag.expanded',
            );
          }
        }
      } catch (err) {
        deps.logger.warn({ err, meetingId: input.meetingId }, 'pipeline.crag.failed');
      }
    }
  }
  if (trace !== null) {
    trace.push(
      stageRecord('crag', cragRan ? 'ran' : 'skipped', cragStart, {
        ...(cragRan ? { decision: cragAdopted ? 'adopted' : 'kept_original' } : {}),
        reason: missed ? 'miss' : weak ? 'low_confidence' : 'confident',
        data: { hits: hits.length },
      }),
    );
  }

  // ── 0 hits ⇒ recordMiss(no_hits) gated by the heuristic ──────────────
  const nohitsStart = Date.now();
  if (hits.length === 0) {
    // Re-apply the cheap heuristic: a clearly-filler utterance that happened to
    // retrieve nothing is not a gap (AE6). (The gate already let filler short-
    // circuit above, but `shouldRecordMiss` is the canonical gap predicate.)
    const notFiller = shouldRecordMiss({
      reason: 'no_hits',
      relevance: classifyRelevanceHeuristic(input.utteranceText),
    });
    if (notFiller) {
      sink.recordMiss({
        verbatimQuestion: input.utteranceText,
        utteranceId: input.utteranceId,
        meetingId: input.meetingId,
        orgId: input.orgId,
        reason: 'no_hits',
      });
    }
    if (trace !== null) {
      // Self-contained empty hybrid-search stage (no cards survived). Same
      // shape as the populated case so the panel's `data.hits` path is uniform.
      trace.push({
        stage: 'hybrid-search',
        status: 'ran',
        latencyMs: searchLatencyMs,
        data: { hits: [], count: 0 },
      });
      trace.push(
        stageRecord('no-hits', 'short_circuited', nohitsStart, {
          decision: 'miss',
          reason: 'no_hits_after_crag',
          data: { filler: !notFiller, recordedGap: notFiller },
        }),
      );
      emitTrace();
    }
    return { emitted: 0, skipped: 'no_hits' };
  }
  if (trace !== null) {
    trace.push(
      stageRecord('no-hits', 'ran', nohitsStart, {
        decision: 'pass',
        data: { hits: hits.length },
      }),
    );
  }

  // ── Stage: chunk/doc enrichment + dedup/parent-expand ────────────────
  const dedupStart = Date.now();
  const enriched = await enrichHits(input, deps, hits);

  const parentOn = deps.parentDocEnabled();
  const sourceHits = parentOn
    ? deps.dedupeByDoc(hits, (h) => enriched.chunkById.get(h.chunk_id)?.docId)
    : hits;
  const winners: WinningChunk[] = sourceHits.flatMap((h) => {
    const c = enriched.chunkById.get(h.chunk_id);
    return c === undefined
      ? []
      : [{ chunkId: h.chunk_id, docId: c.docId, position: c.position, text: c.text }];
  });
  const expandedByChunk = parentOn
    ? await deps.expandWinnersToParents(input.orgId, winners)
    : new Map<string, string>();
  if (trace !== null) {
    trace.push(
      stageRecord('dedup-expand', 'ran', dedupStart, {
        data: { surviving: sourceHits.length, parentDoc: parentOn },
      }),
    );
  }

  // ── Stage: same-source answer-dedup (live answer-dedup, Mechanism B) ──
  // Once the surviving docId set is known, ask the adapter whether this exact
  // source set was already used for a recent grounded answer this meeting. If so,
  // a new answer would just repeat an already-shown source — emit NO cards, run
  // NO synthesis. Gated behind the optional predicate, so eval/legacy callers
  // (no predicate) are unaffected. Conservative: only fires when the candidate
  // set adds no new source (see the predicate's contract).
  if (deps.isDuplicateAnswerSources !== undefined) {
    const candidateDocIds = Array.from(
      new Set(
        sourceHits.flatMap((h) => {
          const docId = enriched.chunkById.get(h.chunk_id)?.docId;
          return docId === undefined ? [] : [docId];
        }),
      ),
    );
    if (deps.isDuplicateAnswerSources(candidateDocIds)) {
      sink.recordSkip({ stage: 'answer-dedup', reason: 'duplicate_answer_sources' });
      if (trace !== null) {
        trace.push(
          stageRecord('dedup-expand', 'short_circuited', dedupStart, {
            decision: 'skip',
            reason: 'duplicate_answer_sources',
            data: { candidates: candidateDocIds.length },
          }),
        );
        emitTrace();
      }
      deps.logger.info(
        { meetingId: input.meetingId, candidates: candidateDocIds.length },
        'pipeline.answer_dedup.skip',
      );
      return { emitted: 0, skipped: 'duplicate_answer_sources' };
    }
  }

  // ── Stage: emit one card per surviving document ──────────────────────
  let emitted = 0;
  const surfacedCardIds: string[] = [];
  const synthesisSources: SynthesisSource[] = [];
  // Self-contained hybrid-search trace hits (R6 follow-up): collected per
  // surfaced card so the `hybrid-search` stage carries its own ranked set and
  // the panel needn't splice the separate `card` events. ONLY allocated when
  // tracing — zero-cost when no trace sink (prod allocates nothing, pushes
  // nothing). Pushed as the stage's `data.hits` after the loop.
  const traceHits: TraceHit[] | null = trace !== null ? [] : null;
  for (let i = 0; i < sourceHits.length; i += 1) {
    const hit = sourceHits[i];
    if (hit === undefined) continue;
    const chunk = enriched.chunkById.get(hit.chunk_id);
    if (chunk === undefined) continue;
    const doc = enriched.docById.get(chunk.docId);
    if (doc === undefined) continue;

    const expanded = expandedByChunk.get(hit.chunk_id) ?? chunk.text;
    const body = expanded.includes(chunk.text) ? expanded : `${chunk.text}\n\n${expanded}`;
    const snippet = body.length > 400 ? body.slice(0, 400) + '…' : body;
    const score = hit.distance !== null ? clamp01(1 - hit.distance / 2) : 0.5;

    const card: PipelineCard = {
      docId: chunk.docId,
      source: doc.source,
      type: doc.type,
      title: doc.title,
      snippet,
      body,
      score,
      rank: i,
      isSummary: chunk.isSummary,
      metadata: { distance: hit.distance, chunkPosition: chunk.position, isSummary: chunk.isSummary },
      utteranceId: input.utteranceId,
      traceId,
      ...(doc.url !== null ? { url: doc.url } : {}),
      // Eval-only source intermediates (the supabase + ws sinks ignore these).
      rrfScore: hit.score,
      distance: hit.distance,
      ftsMatched: hit.ftsMatched,
      position: chunk.position,
      focus: chunk.text,
      chunkId: hit.chunk_id,
    };

    const emittedCard = await sink.emitCard(card);
    if (emittedCard === null) continue; // sink dropped it (e.g. failed insert)

    surfacedCardIds.push(emittedCard.cardId);
    synthesisSources.push({
      rank: i + 1, // synthesizer expects 1-indexed
      text: expanded,
      focus: chunk.text,
      docId: chunk.docId,
      title: doc.title,
    });
    if (traceHits !== null) {
      traceHits.push({
        rank: i + 1, // 1-indexed, matching the `card` event the panel rendered
        title: doc.title,
        score,
        distance: hit.distance,
        ftsMatched: hit.ftsMatched,
        isSummary: chunk.isSummary,
      });
    }
    emitted += 1;
  }

  // Push the self-contained hybrid-search stage record now that titles/
  // isSummary are enriched (latency frozen at search time). Inside the trace
  // guard — prod (no trace sink) does none of this.
  if (trace !== null && traceHits !== null) {
    trace.push({
      stage: 'hybrid-search',
      status: 'ran',
      latencyMs: searchLatencyMs,
      data: { hits: traceHits, count: traceHits.length },
    });
    trace.push(
      stageRecord('emit', 'ran', dedupStart, {
        decision: emitted > 0 ? 'emitted' : 'none',
        data: { emitted, cards: surfacedCardIds.length },
      }),
    );
  }

  // ── Router result collection + skill execution ───────────────────────
  const toolSource = await collectToolSource(
    input,
    deps,
    sink,
    traceId,
    classifierController,
    classifierPromise,
    trace,
  );

  // ── Stage: synthesis (grounded-or-nothing) ───────────────────────────
  if (deps.synthesizer !== undefined && (synthesisSources.length > 0 || toolSource !== null)) {
    const mergedSources = mergeToolSource(toolSource, synthesisSources);
    await runSynthesis({
      input,
      deps,
      sink,
      traceId,
      trace,
      sources: mergedSources,
      surfacedCardIds,
    });
  } else if (trace !== null) {
    trace.push(
      stageRecord('synthesis', 'skipped', Date.now(), {
        reason: deps.synthesizer === undefined ? 'no_synthesizer' : 'no_sources',
      }),
    );
  }

  deps.logger.info(
    { meetingId: input.meetingId, hits: hits.length, emitted },
    'pipeline.complete',
  );
  if (trace !== null) emitTrace();
  return { emitted };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function relevanceContextFrom(input: PipelineInput): PipelineInput['relevanceContext'] {
  if (input.relevanceContext !== undefined) return input.relevanceContext;
  const summary = input.lastSummary;
  if (summary === undefined) return undefined;
  return {
    ...(summary.current_topic !== undefined ? { current_topic: summary.current_topic } : {}),
    open_questions: summary.open_questions,
  };
}

const KEY_TERMS_BOOST_ENABLED = process.env.RISEZOME_KEY_TERMS_BOOST === 'true';

function keyTermsBoost(input: PipelineInput): string {
  if (!KEY_TERMS_BOOST_ENABLED) return '';
  // Question-anchored queries (KTD5) must not be re-diluted by the meeting's
  // key terms; the boost is ambient-only.
  if (input.lane === 'question') return '';
  const summary = input.lastSummary;
  if (summary === undefined || summary.key_terms.length === 0) return '';
  return ` ${summary.key_terms.join(' ')}`;
}

interface EnrichedChunk {
  readonly docId: string;
  readonly text: string;
  readonly position: number;
  readonly isSummary: boolean;
}
interface EnrichedDoc {
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
}
interface Enriched {
  readonly chunkById: Map<string, EnrichedChunk>;
  readonly docById: Map<string, EnrichedDoc>;
}

/** Fetch chunk + doc metadata for the hit set (org-scoped, defense-in-depth).
 *  The only raw DB reads the core does — a future engine-pure core would inject
 *  these rows (KTD2). */
async function enrichHits(
  input: PipelineInput,
  deps: PipelineDeps,
  hits: readonly HybridHit[],
): Promise<Enriched> {
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await deps.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, domain, text, position, is_summary')
    .in('chunk_id', chunkIds)
    .eq('org_id', input.orgId); // defense-in-depth: service-role bypasses RLS
  const chunkById = new Map<string, EnrichedChunk>(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        docId: c.doc_id as string,
        text: c.text as string,
        position: c.position as number,
        isSummary: c.is_summary === true,
      },
    ]),
  );
  const docIds = Array.from(new Set(Array.from(chunkById.values()).map((c) => c.docId)));
  const { data: docRows } = await deps.db
    .from('docs')
    .select('id, source, type, title, url')
    .in('id', docIds)
    .eq('org_id', input.orgId); // defense-in-depth: service-role bypasses RLS
  const docById = new Map<string, EnrichedDoc>(
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
  return { chunkById, docById };
}

/** Await the parallel router classifier, execute the chosen skill, and return
 *  the tool source (or null). Mirrors retrieval.ts's router-collection block,
 *  kept sink-agnostic. */
async function collectToolSource(
  input: PipelineInput,
  deps: PipelineDeps,
  sink: PipelineSink,
  traceId: string,
  controller: AbortController | null,
  classifierPromise: ReturnType<NonNullable<PipelineDeps['routerClassifier']>['classify']> | null,
  trace: TraceBuilder | null,
): Promise<SynthesisSource | null> {
  const skillStart = Date.now();
  const pushSkill = (decision: string, reason: string, data?: Record<string, unknown>): void => {
    if (trace !== null) {
      trace.push(
        stageRecord('skill', 'ran', skillStart, {
          decision,
          reason,
          ...(data !== undefined ? { data } : {}),
        }),
      );
    }
  };
  if (classifierPromise === null || deps.skillRegistry === undefined) {
    pushSkill('none', 'router_not_fired');
    return null;
  }
  try {
    const result = await classifierPromise;
    if (result.intent !== 'tool') {
      // KTD6: the router classifier chose RAG over any skill. This is the exact
      // skill-vs-RAG decision the replay harness needs — record the intent so a
      // clear skill-intent question that lost to RAG is diagnosable.
      pushSkill('none', 'not_tool_intent', { intent: result.intent });
      return null;
    }
    const skill: Skill | undefined = deps.skillRegistry.lookup(result.skillName);
    if (skill === undefined) {
      deps.logger.warn(
        {
          meetingId: input.meetingId,
          utteranceId: input.utteranceId,
          skillName: result.skillName,
          code: 'unknown-skill',
        },
        'pipeline.skill.failed',
      );
      pushSkill('dropped', `unknown_skill:${result.skillName}`, {
        intent: 'tool',
        skillName: result.skillName,
        args: result.args,
      });
      return null;
    }
    try {
      const skillContext: SkillContext = {
        db: deps.db,
        orgId: input.orgId,
        ...(controller !== null ? { signal: controller.signal } : {}),
      };
      const skillResult = await skill.handler(result.args, skillContext);
      // Surface the raw structured answer as a standalone signal (the dev page
      // renders it as its own card) so the executed-skill result is always
      // visible, INDEPENDENT of whether the synthesizer relays it (it can
      // refuse) and of whether the safety-net keeps the tool source below. The
      // tool result still rides into synthesis at [0] either way. Optional +
      // `?.`-guarded so prod/eval sinks (which omit it) are unaffected.
      sink.recordSkillResult?.({
        traceId,
        utteranceId: input.utteranceId,
        skillName: result.skillName,
        args: result.args,
        kind: skillResult.kind,
        summary: skillResult.summary,
        items: skillResult.items ?? [],
      });
      const decision = decideToolSource(skillResult);
      if (decision.keep) {
        pushSkill('kept', `${result.skillName} → source[0]`, {
          intent: 'tool',
          skillName: result.skillName,
          args: result.args,
        });
        return formatAsSource(skillResult, result.skillName, result.args);
      }
      pushSkill('dropped', `safety_net:${decision.status}`, {
        intent: 'tool',
        skillName: result.skillName,
        args: result.args,
      });
      return null;
    } catch (err) {
      const code = err instanceof SkillExecutionError ? err.executionCode : 'execution-error';
      deps.logger.warn(
        {
          meetingId: input.meetingId,
          utteranceId: input.utteranceId,
          skillName: result.skillName,
          code,
          message: (err as Error).message,
        },
        'pipeline.skill.failed',
      );
      pushSkill('dropped', `skill_error:${code}`);
      return null;
    }
  } catch (err) {
    if (err instanceof ClassifierProviderError) {
      deps.logger.warn(
        { meetingId: input.meetingId, code: err.kind, message: err.message },
        'pipeline.classifier.error',
      );
      pushSkill('none', `classifier_error:${err.kind}`);
    } else if (err instanceof Error && err.name === 'AbortError') {
      // timeout — silent
      pushSkill('none', 'classifier_timeout');
    } else {
      deps.logger.warn(
        { meetingId: input.meetingId, message: (err as Error).message },
        'pipeline.classifier.error',
      );
      pushSkill('none', 'classifier_error');
    }
    return null;
  }
}

/**
 * Drive one synthesis end-to-end with EARLY-STREAMING + grounded-or-nothing
 * (U3, KTD3/KTD4). The synthesizer output starts with a machine-readable STATUS
 * prefix (`STATUS: answer` / `STATUS: no_relevant_context`), so the refuse-vs-
 * answer decision is known BEFORE the prose. We exploit that to stream a
 * `STATUS: answer` body to the live page as it generates, while NEVER streaming
 * a refusal.
 *
 * Per textDelta we run `stripStatusPrefix(accumulated)`:
 *   - complete === false                  → prefix still forming, keep buffering.
 *   - complete, status 'no_relevant_context' → refusal: never stream; handled at
 *                                           `done` on the existing refusal path.
 *   - complete, status 'answer'           → stream: synthesisStart once, then
 *                                           emit the NEW prose via synthesisDelta
 *                                           at sentence/clause boundaries (KTD4 —
 *                                           no raw per-token flicker).
 *
 * At `done` the EXISTING grounding gate is unchanged (parseSynthesisOutput →
 * refusal check → verifyCitationsDetailed → rich citations). The outcome routes:
 *   refusal              → (streamed? synthesisRetract : synthesisRefusal) +
 *                          recordMiss('refusal')
 *   grounded (>0 cites)  → streamed? synthesisDone (finalize) : legacy reveal
 *                          (synthesisStart → synthesisDelta(text) → synthesisDone)
 *   ungrounded (0 cites) → streamed? synthesisRetract (CLEAR the streamed answer)
 *                          : synthesisRefusal — both + recordMiss('ungrounded')
 *
 * GROUNDED-OR-NOTHING (R1): a STATUS_NO_CONTEXT refusal never resolves to
 * 'answer', so it never calls synthesisStart/Delta — it is never streamed. Only
 * a STATUS_ANSWER that later fails citation verification is streamed-then-
 * retracted. The retract clears the revealed prose; nothing ungrounded stands.
 *
 * CITATION MARKUP: the streamed `body` carries inline citation markers
 * (`[N: "quote"]`); the final synthesisDone sends `parsed.text` (same source
 * string, STATUS line stripped). The live page parses citation tokens out of the
 * accumulated stream and reconciles to the verified citation set on done, so
 * streaming the raw body then finalizing is intentional. (Follow-up: incremental
 * citation-quote stripping during the stream is deferred — non-trivial and the
 * render layer already hides the quote payload.)
 */
async function runSynthesis(args: {
  input: PipelineInput;
  deps: PipelineDeps;
  sink: PipelineSink;
  traceId: string;
  trace: TraceBuilder | null;
  sources: readonly SynthesisSource[];
  surfacedCardIds: readonly string[];
}): Promise<void> {
  const { input, deps, sink, traceId, trace, sources, surfacedCardIds } = args;
  if (deps.synthesizer === undefined) return;

  const synthStart = Date.now();
  const synthesisId = `synth_${randomUUID()}`;
  let accumulated = '';
  let startUsage: SynthesisUsage | null = null;

  // ── Streaming state (U3/KTD3) ────────────────────────────────────────────
  // `streaming` flips true the first time the STATUS prefix resolves to
  // 'answer' and we emit synthesisStart. `streamedLen` tracks how much of the
  // post-prefix BODY we've already sent as deltas, so each delta carries only
  // the NEW prose. A STATUS_NO_CONTEXT refusal never resolves to 'answer', so
  // `streaming` stays false and nothing is ever revealed for it (grounded-or-
  // nothing, R1).
  let streaming = false;
  let streamedLen = 0;

  const startStreamingIfNeeded = (): void => {
    if (streaming) return;
    streaming = true;
    sink.synthesisStart({
      synthesisId,
      sourceCardIds: surfacedCardIds,
      traceId,
      utteranceId: input.utteranceId,
    });
  };

  /**
   * Emit any NEW prose in `body` past `streamedLen`, buffered to sentence/
   * clause boundaries (KTD4 — flush on `.`/`!`/`?`/newline, not raw tokens).
   * `force` flushes the remaining tail unconditionally (used on `done` so the
   * page's accumulatedText equals the full body before finalize). Returns
   * nothing; advances `streamedLen`.
   */
  const flushSentences = (body: string, force: boolean): void => {
    if (!streaming) return;
    if (body.length <= streamedLen) return;
    let flushTo = streamedLen;
    if (force) {
      flushTo = body.length;
    } else {
      // Longest boundary at or before the current end of `body`, after
      // streamedLen. A boundary is a terminator (. ! ? newline) — we flush
      // through the char after it so the punctuation rides with its sentence.
      for (let i = body.length - 1; i >= streamedLen; i -= 1) {
        const ch = body[i]!;
        if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
          flushTo = i + 1;
          break;
        }
      }
    }
    if (flushTo <= streamedLen) return; // no boundary yet — keep buffering
    const delta = body.slice(streamedLen, flushTo);
    streamedLen = flushTo;
    sink.synthesisDelta(synthesisId, delta);
  };

  const recentContext = input.recentContext;

  try {
    for await (const chunk of deps.synthesizer.synthesize({
      utterance: input.queryText,
      sources,
      maxTokens: SYNTHESIS_MAX_TOKENS,
      ...(recentContext !== undefined && recentContext.length > 0 ? { recentContext } : {}),
    })) {
      if (chunk.type === 'start') {
        startUsage = chunk.usage;
      } else if (chunk.type === 'textDelta') {
        accumulated += chunk.delta;
        // Inspect the buffer for the STATUS prefix as it forms. Until it
        // resolves we hold output; once it resolves to 'answer' we stream the
        // post-prefix prose at sentence boundaries; a refusal never streams.
        const gate = stripStatusPrefix(accumulated);
        if (gate.complete && gate.status === 'answer') {
          startStreamingIfNeeded();
          flushSentences(gate.body, false);
        }
        // gate.status === 'no_relevant_context' or !complete → keep buffering.
      } else if (chunk.type === 'done') {
        const latencyMs = Date.now() - synthStart;
        const parsed = parseSynthesisOutput(accumulated, sources.length);
        // S14 — the model produced output.
        if (trace !== null) {
          trace.push(
            stageRecord('synthesis', 'ran', synthStart, {
              decision: 'generated',
              data: { chars: accumulated.length, sources: sources.length, streamed: streaming },
            }),
          );
        }

        if (parsed.isRefusal) {
          // A STATUS_NO_CONTEXT refusal. The common case never streamed, so it
          // takes the unchanged synthesisRefusal path. Defensively: if we DID
          // stream (the STATUS prefix diverged then re-classified as a refusal
          // — should not happen for a real STATUS_NO_CONTEXT), retract the
          // revealed prose instead of leaving it standing.
          if (streaming) {
            sink.synthesisRetract({
              synthesisId,
              reason: 'refusal',
              latencyMs,
              utteranceId: input.utteranceId,
              traceId,
              rawSynthesis: accumulated,
              answer: parsed.text,
              refusalReason: parsed.refusalReason ?? null,
              citationDetails: [],
            });
          } else {
            sink.synthesisRefusal({
              synthesisId,
              reason: 'refusal',
              latencyMs,
              utteranceId: input.utteranceId,
              traceId,
              rawSynthesis: accumulated,
              answer: parsed.text,
              refusalReason: parsed.refusalReason ?? null,
              citationDetails: [],
            });
          }
          sink.recordMiss({
            verbatimQuestion: input.queryText,
            utteranceId: input.utteranceId,
            meetingId: input.meetingId,
            orgId: input.orgId,
            reason: 'refusal',
            sourcesSearched: sources.map((s) => s.title),
          });
          // S15 — refusal gate caught a STATUS: no_relevant_context.
          if (trace !== null) {
            trace.push(
              stageRecord('refusal-gate', 'short_circuited', synthStart, {
                decision: 'refusal',
                reason: parsed.refusalReason ?? 'no_relevant_context',
              }),
            );
          }
          return;
        }

        // S15 — refusal gate passed (not a no_relevant_context refusal).
        if (trace !== null) {
          trace.push(
            stageRecord('refusal-gate', 'ran', synthStart, { decision: 'pass' }),
          );
        }

        // Citation verification → grounded-or-nothing.
        const detail = verifyCitationsDetailed(parsed.citations, sources);
        const survivors = detail.filter((d) => d.status !== 'dropped');
        if (trace !== null) {
          trace.push(
            stageRecord('citation-verify', 'ran', synthStart, {
              decision: survivors.length === 0 ? 'ungrounded' : 'pass',
              data: {
                total: detail.length,
                surviving: survivors.length,
                dropped: detail.filter((d) => d.status === 'dropped').length,
                downgraded: detail.filter((d) => d.status === 'downgraded').length,
              },
            }),
          );
        }

        const richCitations = survivors.flatMap((c) => {
          const cardId = surfacedCardIds[c.rank - 1];
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

        if (richCitations.length === 0) {
          // Ungrounded: an answer that cited nothing groundable. If it WAS
          // streamed (STATUS_ANSWER whose citations failed verification — the
          // one case prose was revealed but must not stand), RETRACT to clear
          // the revealed prose. Otherwise (never streamed) suppress like a
          // refusal. Either way recordMiss('ungrounded'). (R1.)
          if (streaming) {
            sink.synthesisRetract({
              synthesisId,
              reason: 'ungrounded',
              latencyMs,
              utteranceId: input.utteranceId,
              traceId,
              rawSynthesis: accumulated,
              answer: parsed.text,
              refusalReason: parsed.refusalReason ?? null,
              citationDetails: detail,
            });
          } else {
            sink.synthesisRefusal({
              synthesisId,
              reason: 'ungrounded',
              latencyMs,
              utteranceId: input.utteranceId,
              traceId,
              rawSynthesis: accumulated,
              answer: parsed.text,
              refusalReason: parsed.refusalReason ?? null,
              citationDetails: detail,
            });
          }
          sink.recordMiss({
            verbatimQuestion: input.queryText,
            utteranceId: input.utteranceId,
            meetingId: input.meetingId,
            orgId: input.orgId,
            reason: 'ungrounded',
            sourcesSearched: sources.map((s) => s.title),
          });
          // Ungrounded: the citation-verify miss (decision 'ungrounded') is the
          // terminal stop; reveal (S17) is never reached.
          return;
        }

        // Grounded. If we streamed the prose, flush any unstreamed tail so the
        // page's accumulated text equals the full body, then finalize with the
        // verified citation set. If we never streamed (the STATUS prefix never
        // resolved to 'answer' yet the answer grounded — a diverged/legacy
        // output), fall back to the whole-answer reveal so nothing regresses.
        if (streaming) {
          flushSentences(parsed.text, true);
        } else {
          startStreamingIfNeeded();
          sink.synthesisDelta(synthesisId, parsed.text);
        }
        sink.synthesisDone({
          synthesisId,
          text: parsed.text,
          citations: richCitations,
          stopReason: chunk.stopReason,
          latencyMs,
          utteranceId: input.utteranceId,
          // Mechanism B: the grounded source docIds (deduped, order-independent
          // on the consumer) so the adapter records this answer's source set.
          // A tool source (source[0]) carries no docId — filter those out.
          sourceDocIds: Array.from(
            new Set(sources.flatMap((s) => (s.docId !== undefined ? [s.docId] : []))),
          ),
          rawSynthesis: accumulated,
          citationDetails: detail,
        });
        // S17 — reveal: the grounded answer was streamed + persisted.
        if (trace !== null) {
          trace.push(
            stageRecord('reveal', 'ran', synthStart, {
              decision: 'revealed',
              data: { citations: richCitations.length, encrypted: true, streamed: streaming },
            }),
          );
        }
        return;
      }
    }
  } catch (err) {
    deps.logger.warn({ err, synthesisId, meetingId: input.meetingId }, 'pipeline.synthesis.failed');
    // A synthesizer error mid-stream must not leave a partial answer standing
    // (R1/AE1). If we already revealed prose, retract it; the answer was never
    // grounded (the `done` gate never ran). Record the miss as a refusal so the
    // knowledge gap is captured.
    if (streaming) {
      sink.synthesisRetract({
        synthesisId,
        reason: 'refusal',
        latencyMs: Date.now() - synthStart,
        utteranceId: input.utteranceId,
        traceId,
        rawSynthesis: accumulated,
        answer: '',
        refusalReason: (err as Error).message,
        citationDetails: [],
      });
      sink.recordMiss({
        verbatimQuestion: input.queryText,
        utteranceId: input.utteranceId,
        meetingId: input.meetingId,
        orgId: input.orgId,
        reason: 'refusal',
        sourcesSearched: sources.map((s) => s.title),
      });
    }
    if (trace !== null) {
      trace.push(
        stageRecord('synthesis', 'ran', synthStart, {
          decision: 'errored',
          reason: (err as Error).message,
        }),
      );
    }
  }
  // Silence "assigned but never used" when synthesis ends without a done event.
  void startUsage;
}
