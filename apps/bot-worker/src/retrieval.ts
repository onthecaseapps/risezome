import { randomUUID } from 'node:crypto';
import { VoyageEmbedder } from '@risezome/engine/embed';
import type {
  Synthesizer,
  SynthesisSource,
  SynthesisUsage,
} from '@risezome/engine/synthesize';
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

const UTTERANCE_THRESHOLD = 3; // retrieve after every 3rd final utterance
const COOLDOWN_MS = 10_000; // ... but at most once per 10s
const TOP_K = 3;
const WINDOW_UTTERANCES = 8; // last 8 final utterances form the query

export interface RetrievalRuntime {
  /** Concatenated text of recent final utterances. */
  recentFinals: string[];
  utteranceCountSinceLastRetrieval: number;
  lastRetrievalAt: number;
}

export function newRetrievalRuntime(): RetrievalRuntime {
  return {
    recentFinals: [],
    utteranceCountSinceLastRetrieval: 0,
    lastRetrievalAt: 0,
  };
}

interface CardPayload {
  cardId: string;
  docId: string;
  source: string;
  type: string;
  title: string;
  snippet: string;
  score: number;
  rank: number;
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

  // Embed the rolling-window text as the query. Use text-domain so
  // we hit voyage-3-large (matching the prose chunks of the indexed
  // corpus). Code-chunk recall via prose queries is the cross-space
  // limitation called out in the /debug/ask page — same caveat applies.
  let queryEmbedding: Float32Array;
  try {
    const result = await args.embedder.embed({
      items: [{ text: queryText, domain: 'text' }],
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
  const { data: vectorRows, error: vectorErr } = await args.db.rpc('search_corpus_vector', {
    p_org_id: args.orgId,
    p_query_vector: queryLiteral,
    p_limit: TOP_K,
  });

  if (vectorErr !== null) {
    args.logger.warn({ err: vectorErr, meetingId: args.meetingId }, 'retrieval.search.failed');
    return { emitted: 0, skipped: 'search_failed' };
  }
  const hits = (vectorRows ?? []) as Array<{ chunk_id: string; distance: number }>;
  if (hits.length === 0) {
    return { emitted: 0, skipped: 'no_hits' };
  }

  // Fetch chunk + doc metadata in two more round-trips (mirrors the
  // /debug/ask page's enrichment shape).
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await args.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, domain, text, position')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        doc_id: c.doc_id as string,
        domain: c.domain as string,
        text: c.text as string,
        position: c.position as number,
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

  const traceId = randomUUID();
  let emitted = 0;
  const surfacedCardIds: string[] = [];
  const synthesisSources: SynthesisSource[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]!;
    const chunk = chunkById.get(hit.chunk_id);
    if (chunk === undefined) continue;
    const doc = docById.get(chunk.doc_id);
    if (doc === undefined) continue;

    // Persist the card row (RLS-scoped by org_id; insert via service
    // role) BEFORE the broadcast, per R23a.
    const cardId = `card_${randomUUID()}`;
    const snippet = chunk.text.length > 400 ? chunk.text.slice(0, 400) + '…' : chunk.text;
    // cosine distance is in [0, 2]; convert to a [0, 1] similarity-ish
    // score so the HUD's score field aligns with what the HUD currently
    // expects (the daemon emits cosine similarity).
    const score = clamp01(1 - hit.distance / 2);

    const { error: cardErr } = await args.db.from('cards').insert({
      card_id: cardId,
      meeting_id: args.meetingId,
      org_id: args.orgId,
      doc_id: chunk.doc_id,
      source: doc.source,
      type: doc.type,
      title: doc.title,
      snippet,
      score,
      rank: i,
      metadata: { distance: hit.distance, chunkPosition: chunk.position },
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
      score,
      rank: i,
      metadata: { distance: hit.distance, chunkPosition: chunk.position },
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
    surfacedCardIds.push(cardId);
    synthesisSources.push({
      rank: i + 1, // synthesizer expects 1-indexed
      title: doc.title,
      text: chunk.text,
    });
    emitted += 1;
  }

  // ── Synthesis ─────────────────────────────────────────────────────
  // After cards are emitted, kick off Anthropic synthesis across them.
  // Streams the result back as batched synthesisDelta broadcasts so the
  // live page's right panel populates as tokens arrive. Fire-and-forget
  // from the caller's perspective — we don't block the retrieval-tick
  // return on synthesis completion.
  if (args.synthesizer !== undefined && synthesisSources.length > 0) {
    void runSynthesisAndBroadcast({
      synthesizer: args.synthesizer,
      utterance: queryText,
      sources: synthesisSources,
      surfacedCardIds,
      traceId,
      meetingId: args.meetingId,
      orgId: args.orgId,
      db: args.db,
      logger: args.logger,
    });
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

const SYNTHESIS_FLUSH_INTERVAL_MS = 250;
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
  traceId: string;
  meetingId: string;
  orgId: string;
  db: SupabaseClient;
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}): Promise<void> {
  const synthesisId = `synth_${randomUUID()}`;
  let accumulated = '';
  let lastFlushedLength = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let startUsage: SynthesisUsage | null = null;
  const startedAt = Date.now();

  // syntheses row keyed by synthesis_id; insert once at start, update
  // accumulated_text + status on each significant event.
  const insertResult = await args.db.from('syntheses').insert({
    synthesis_id: synthesisId,
    meeting_id: args.meetingId,
    org_id: args.orgId,
    source_card_ids: args.surfacedCardIds,
    accumulated_text: '',
    status: 'running',
    citations: [],
    trace_id: args.traceId,
  });
  if (insertResult.error !== null) {
    args.logger.warn({ err: insertResult.error, synthesisId }, 'synthesis.insert.failed');
    return;
  }

  // Helper: flush the current buffer as a single synthesisDelta broadcast.
  const flush = async (): Promise<void> => {
    if (accumulated.length === lastFlushedLength) return;
    const delta = accumulated.slice(lastFlushedLength);
    lastFlushedLength = accumulated.length;
    // Persist accumulated_text snapshot first (R23a), then broadcast.
    await args.db
      .from('syntheses')
      .update({ accumulated_text: accumulated })
      .eq('synthesis_id', synthesisId);
    await persistAndBroadcast(args.db, {
      meetingId: args.meetingId,
      orgId: args.orgId,
      type: 'synthesisDelta',
      payload: { delta: { synthesisId, delta } },
    });
  };

  // Emit synthesisStart before the first token. The reducer uses this
  // to allocate the synthesis card on the right panel.
  await persistAndBroadcast(args.db, {
    meetingId: args.meetingId,
    orgId: args.orgId,
    type: 'synthesisStart',
    payload: {
      start: {
        synthesisId,
        sourceCardIds: args.surfacedCardIds,
        traceId: args.traceId,
      },
    },
  });

  try {
    for await (const chunk of args.synthesizer.synthesize({
      utterance: args.utterance,
      sources: args.sources,
      maxTokens: SYNTHESIS_MAX_TOKENS,
    })) {
      if (chunk.type === 'start') {
        startUsage = chunk.usage;
      } else if (chunk.type === 'textDelta') {
        accumulated += chunk.delta;
        // Throttle broadcasts: only fire flush if no timer pending.
        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            void flush();
          }, SYNTHESIS_FLUSH_INTERVAL_MS);
        }
      } else if (chunk.type === 'done') {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flush(); // final delta with the tail tokens

        const latencyMs = Date.now() - startedAt;
        await args.db
          .from('syntheses')
          .update({
            status: 'done',
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
          type: 'synthesisDone',
          payload: {
            done: {
              synthesisId,
              stopReason: chunk.stopReason,
              citations: [], // Citation extraction lives in the daemon's
                            // pipeline; not lifted yet (see U9e + the
                            // parseSynthesisOutput helper in engine).
              usage: chunk.usage,
              ttftMs: 0, // Not currently measured at this layer.
              latencyMs,
            },
          },
        });

        args.logger.info(
          { synthesisId, meetingId: args.meetingId, latencyMs, outputTokens: chunk.usage.outputTokens },
          'synthesis.done',
        );
        return;
      }
    }
  } catch (err) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
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
