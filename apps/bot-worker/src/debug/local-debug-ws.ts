/**
 * Local-debug WebSocket endpoint.
 *
 * Debug-only path that mirrors the production Recall pipeline using the
 * Linux PulseAudio sidecar as the audio source. Lets prompt + filter
 * iteration happen against the user's mic / system audio without
 * spawning a Recall bot per test.
 *
 * Lifecycle:
 *   1. Portal opens WS to /local-debug with a Bearer token (JWT signed
 *      with BOT_WORKER_SECRET; carries orgId).
 *   2. Server spawns SidecarRunner + DeepgramTranscriptionEngine.
 *   3. PCM frames from sidecar → engine.sendFrame.
 *   4. Deepgram emits finalized utterances → debug pipeline:
 *      embed → corpus search → emit cards → synthesizer → stream
 *      textDeltas → emit done.
 *   5. All events are sent as JSON messages over the WS for the portal
 *      to render. NO Supabase persistence; NO Realtime broadcast — the
 *      debug page reads everything from the WS directly.
 *   6. On WS close (client disconnect, server shutdown), stop the
 *      sidecar runner and Deepgram engine.
 *
 * NOT FOR PRODUCTION. Auth is intentionally lighter than the Recall
 * path (no per-meeting JWT scoping, no rate-limit), and the pipeline
 * skips persistence entirely. Gate the route behind a env flag in
 * production deployments.
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket } from 'ws';
import { SidecarRunner } from './sidecar-runner.js';
import { DeepgramTranscriptionEngine } from './deepgram.js';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  AnthropicSynthesizer,
  parseSynthesisOutput,
  type SynthesisSource,
} from '@risezome/engine/synthesize';
import { AnthropicSummarizer, type MeetingSummary } from '@risezome/engine/summarize';
import {
  AnthropicRelevanceClassifier,
  classifyRelevanceHeuristic,
  type RelevanceClassifier,
} from '@risezome/engine/relevance';
import type { AudioFrame } from '@risezome/shared-types';
import type { Utterance } from '@risezome/engine/transcribe';
import { MeetingSummarizerRuntime } from '../summarizer-runtime.js';

export interface LocalDebugHandlerArgs {
  readonly db: SupabaseClient;
  readonly orgId: string;
  readonly anthropicKey: string;
  readonly anthropicModel: string;
  readonly voyageKey: string;
  readonly deepgramKey: string;
  readonly sidecarPath?: string;
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
  };
}

const TOP_K = 5;
const SYNTHESIS_MAX_TOKENS = 200;

// Relevance gate config — mirrors apps/bot-worker/src/retrieval.ts so the
// debug pipeline has the same cost shape as production Recall.
const RELEVANCE_SKIP_THRESHOLD = 0.7;
const RELEVANCE_TIMEOUT_MS = 3_000;

// Voyage embeddings are trained on natural sentences, not keyword bags.
// Concatenating key_terms can EITHER boost recall on short follow-up
// utterances OR degrade similarity. Ship gated behind an env flag for
// the first live test so the behavior can be A/B'd against a recorded
// session. Default OFF.
const KEY_TERMS_BOOST_ENABLED = process.env.RISEZOME_DEBUG_KEY_TERMS_BOOST === 'true';

// Rolling-context tuning. Five utterances or 60 seconds, whichever is
// hit first — long enough to chain a question across 2-3 splits without
// dragging in unrelated prior topics.
const FINALS_BUFFER = 5;
const FINALS_TTL_MS = 60_000;

// Continuation merge: if the new utterance lands within this window
// AND looks-like-continuation (lowercase / connective start), it gets
// concatenated with the prior. Above the window we treat it as a
// fresh utterance even if it starts lowercase (probably a topic break).
const CONTINUATION_WINDOW_MS = 6_000;

// Replace-vs-new card heuristic: if a new synthesis cites a source
// set that overlaps the prior synthesis by this Jaccard threshold AND
// the prior completed within REPLACE_WINDOW_MS, signal the page to
// replace the prior card in place.
const REPLACE_JACCARD_THRESHOLD = 0.5;
const REPLACE_WINDOW_MS = 30_000;

const CONTINUATION_LEADERS = new Set([
  'and', 'but', 'or', 'so',
  'in', 'on', 'at', 'of', 'to', 'for', 'with', 'from',
  'where', 'when', 'how', 'why', 'which', 'who',
  'because', 'since', 'while', 'that',
]);

function looksLikeContinuation(
  prior: { text: string; at: number },
  next: { text: string; at: number },
): boolean {
  if (next.at - prior.at > CONTINUATION_WINDOW_MS) return false;
  const firstWord = next.text.trim().split(/\s+/)[0] ?? '';
  if (firstWord.length === 0) return false;
  // Lowercase start often signals continuation (ASR rarely capitalizes
  // the start of a continuation utterance).
  const firstChar = firstWord[0]!;
  if (firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase()) {
    return true;
  }
  return CONTINUATION_LEADERS.has(firstWord.toLowerCase());
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function handleLocalDebugWs(
  socket: WebSocket,
  args: LocalDebugHandlerArgs,
): Promise<void> {
  const sidecarPath = args.sidecarPath ?? defaultSidecarPath();

  args.logger.info({ orgId: args.orgId, sidecarPath }, 'local-debug.start');

  // The sidecar's nonce-handshake protocol requires a SHA-256 manifest.
  // For debug usage we trust the local binary; compute the SHA on the
  // fly so the user doesn't have to maintain a manifest file.
  let runner: SidecarRunner;
  try {
    const sha = await computeFileSha256(sidecarPath);
    runner = new SidecarRunner({
      sidecarPath,
      manifest: { [sidecarPath]: { sha256: sha } },
      args: ['--role=system'],
    });
  } catch (err) {
    send(socket, { type: 'error', message: `sidecar init failed: ${String((err as Error).message)}` });
    socket.close();
    return;
  }

  const engine = new DeepgramTranscriptionEngine({ apiKey: args.deepgramKey });
  const embedder = new VoyageEmbedder({ apiKey: args.voyageKey });
  const synthesizer = new AnthropicSynthesizer({
    apiKey: args.anthropicKey,
    model: args.anthropicModel,
    maxTokens: SYNTHESIS_MAX_TOKENS,
  });
  const summarizer = new AnthropicSummarizer({
    apiKey: args.anthropicKey,
    model: args.anthropicModel,
  });
  const relevanceClassifier = new AnthropicRelevanceClassifier({
    apiKey: args.anthropicKey,
    model: args.anthropicModel,
  });
  const summarizerRuntime = new MeetingSummarizerRuntime({
    summarizer,
    onSummaryUpdated: (summary, at) => {
      args.logger.info(
        {
          currentTopic: summary.current_topic,
          openQuestions: summary.open_questions.length,
          keyTerms: summary.key_terms.length,
          at,
        },
        'local-debug.summary.updated',
      );
      send(socket, { type: 'summary', summary, at });
    },
    onSummarizerError: (err) => {
      args.logger.warn({ err: String(err) }, 'local-debug.summarizer.error');
    },
  });

  // Per-WS pipeline state.
  //
  // currentSynthesisAbort — abort signal for the in-flight synthesis.
  //   On new utterance, abort the prior so the latest wins. The aborted
  //   synthesis emits `synthesisAborted` so the page can clear its
  //   stuck-streaming card (without this the prior card sits forever
  //   showing "▊").
  //
  // recentFinals — rolling buffer of finalized utterances (oldest first).
  //   Capped at FINALS_BUFFER and aged out after FINALS_TTL_MS so
  //   long-running sessions don't accumulate stale context. Passed to
  //   the synthesizer as `recentContext` so Claude can resolve pronouns
  //   + fragments without an explicit pre-merge step.
  //
  // priorSynth — last completed (non-refusal) synthesis. Used to decide
  //   whether the next synthesis should REPLACE the prior card (same
  //   topic, refined question) or stand alone (different topic). The
  //   page consumes the `replacesSynthesisId` field on synthesisStart.
  let currentSynthesisAbort: AbortController | null = null;
  let currentSynthesisId: string | null = null;
  const recentFinals: { text: string; at: number }[] = [];
  let priorSynth: {
    synthesisId: string;
    sourceCardIds: readonly string[];
    completedAt: number;
  } | null = null;

  runner.on('frame', (frame: AudioFrame) => {
    engine.sendFrame(frame.samples);
  });

  runner.on('error', (err: Error) => {
    args.logger.error({ err: err.message }, 'local-debug.sidecar.error');
    send(socket, { type: 'error', message: `sidecar: ${err.message}` });
  });

  runner.on('stopped', () => {
    args.logger.info({}, 'local-debug.sidecar.stopped');
    send(socket, { type: 'sidecar-stopped' });
  });

  // Forward partial utterances to the client for the live transcript
  // view (no pipeline trigger).
  engine.on('partial', (t) => {
    forwardUtterance(socket, t.utterance);
  });

  // Final utterances flow to the client, get appended to the rolling
  // context, then trigger the retrieval pipeline.
  engine.on('final', (t) => {
    forwardUtterance(socket, t.utterance);
    const text = t.utterance.text.trim();
    if (text.length === 0) return;

    // Feed the summarizer runtime — fires asynchronously when cadence
    // + rate-cap conditions hold. Its onSummaryUpdated broadcasts the
    // new summary as a `summary` WS event.
    summarizerRuntime.recordUtterance(text);

    // Append to rolling buffer + age out old entries.
    const now = Date.now();
    recentFinals.push({ text, at: now });
    while (
      recentFinals.length > 0 &&
      (recentFinals.length > FINALS_BUFFER || now - recentFinals[0]!.at > FINALS_TTL_MS)
    ) {
      recentFinals.shift();
    }

    // Heuristic fragment merge: if the prior final landed within
    // CONTINUATION_WINDOW_MS and the new utterance looks like a
    // continuation (lowercase start, or starts with a connective like
    // "and", "but", "in", "where"), treat the new utterance as
    // extending the prior one. Effective query = concat. We still pass
    // the full recent context as a backstop in case the heuristic is
    // wrong.
    const isContinuation = recentFinals.length >= 2 && looksLikeContinuation(
      recentFinals[recentFinals.length - 2]!,
      recentFinals[recentFinals.length - 1]!,
    );
    const effectiveUtterance = isContinuation
      ? `${recentFinals[recentFinals.length - 2]!.text} ${text}`
      : text;

    // Build recentContext for the synthesizer. The latest rolling
    // summary prose (if any) goes at the head as the OLDEST entry
    // (longest-range context); the recent finals follow in oldest-
    // first order. Reads lastSummary ONCE here (synchronously, before
    // the pipeline starts) so a mid-stream summary refresh can't
    // produce a torn read — the in-flight call keeps the summary it
    // captured at start; the next call picks up the new one.
    const lastSummaryAtBuild = summarizerRuntime.getLastSummary();
    const recentContext = [
      ...(lastSummaryAtBuild !== null && lastSummaryAtBuild.summary.length > 0
        ? [lastSummaryAtBuild.summary]
        : []),
      ...recentFinals.slice(0, -1).map((u) => u.text),
    ];

    // Abort prior in-flight synthesis. Send an aborted event so the
    // page clears the stuck-streaming card.
    if (currentSynthesisAbort !== null && currentSynthesisId !== null) {
      currentSynthesisAbort.abort();
      send(socket, {
        type: 'synthesisAborted',
        synthesisId: currentSynthesisId,
        reason: 'superseded-by-new-utterance',
      });
    }
    const ac = new AbortController();
    currentSynthesisAbort = ac;
    const synthesisId = `synth_${randomUUID()}`;
    currentSynthesisId = synthesisId;

    args.logger.info(
      {
        rawUtterance: text,
        effectiveUtterance,
        isContinuation,
        recentContextSize: recentContext.length,
        bufferSize: recentFinals.length,
      },
      'local-debug.utterance.fire',
    );

    void runDebugPipeline({
      synthesisId,
      utteranceText: effectiveUtterance,
      utteranceId: t.utterance.utteranceId,
      recentContext,
      lastSummary: lastSummaryAtBuild,
      priorSynth,
      socket,
      args,
      embedder,
      synthesizer,
      relevanceClassifier,
      abortSignal: ac.signal,
      onComplete: (sourceCardIds) => {
        priorSynth = { synthesisId, sourceCardIds, completedAt: Date.now() };
        if (currentSynthesisId === synthesisId) {
          currentSynthesisId = null;
          currentSynthesisAbort = null;
        }
      },
    }).catch((err: unknown) => {
      args.logger.warn({ err: String(err) }, 'local-debug.pipeline.error');
      send(socket, { type: 'pipeline-error', message: String(err) });
    });
  });

  engine.on('error', (err: Error) => {
    args.logger.error({ err: err.message }, 'local-debug.deepgram.error');
    send(socket, { type: 'error', message: `deepgram: ${err.message}` });
  });

  // Start them.
  try {
    await engine.start();
    await runner.start();
    send(socket, { type: 'ready' });
  } catch (err) {
    args.logger.error({ err: String(err) }, 'local-debug.start.failed');
    send(socket, { type: 'error', message: `start failed: ${String(err)}` });
    socket.close();
    return;
  }

  const cleanup = async (): Promise<void> => {
    args.logger.info({}, 'local-debug.cleanup');
    if (currentSynthesisAbort !== null) currentSynthesisAbort.abort();
    summarizerRuntime.dispose();
    try {
      await runner.stop();
    } catch (err) {
      args.logger.warn({ err: String(err) }, 'local-debug.runner.stop.error');
    }
    try {
      await engine.stop();
    } catch (err) {
      args.logger.warn({ err: String(err) }, 'local-debug.engine.stop.error');
    }
  };

  socket.on('close', () => {
    void cleanup();
  });
  socket.on('error', (err) => {
    args.logger.warn({ err: String(err) }, 'local-debug.ws.error');
    void cleanup();
  });
}

interface PipelineArgs {
  readonly synthesisId: string;
  readonly utteranceText: string;
  readonly utteranceId: string;
  /** Rolling prior-utterance context passed to the synthesizer. */
  readonly recentContext: readonly string[];
  /** Snapshot of the rolling summary at call-fire time. The pipeline
   *  reads `current_topic` + `open_questions` from this for the
   *  classifier's coherence-in-context judgment, and reads `key_terms`
   *  for the embedding-query boost (env-gated). Captured by the caller
   *  ONCE at fire time so a mid-flight summary refresh can't produce
   *  a torn read. */
  readonly lastSummary: MeetingSummary | null;
  /** Last completed synthesis (if any). Used to compute
   *  replacesSynthesisId on the new synthesisStart so the page can
   *  replace the prior card in place when the new answer is a
   *  refinement on the same topic. */
  readonly priorSynth: {
    synthesisId: string;
    sourceCardIds: readonly string[];
    completedAt: number;
  } | null;
  readonly socket: WebSocket;
  readonly args: LocalDebugHandlerArgs;
  readonly embedder: VoyageEmbedder;
  readonly synthesizer: AnthropicSynthesizer;
  readonly relevanceClassifier: RelevanceClassifier;
  readonly abortSignal: AbortSignal;
  /** Called after the pipeline completes successfully (non-refusal)
   *  so the caller can update `priorSynth`. */
  readonly onComplete: (sourceCardIds: readonly string[]) => void;
}

/**
 * Per-utterance pipeline. Embeds → searches → emits cards → runs
 * synthesizer → streams textDeltas → emits done with citations. No
 * persistence; everything goes to the WS as JSON events.
 */
async function runDebugPipeline(p: PipelineArgs): Promise<void> {
  const traceId = randomUUID();
  const synthesisId = p.synthesisId;
  const { socket, args, embedder, synthesizer, relevanceClassifier, abortSignal } = p;

  args.logger.info(
    { traceId, synthesisId, utteranceId: p.utteranceId, text: p.utteranceText },
    'local-debug.pipeline.start',
  );

  // ── Relevance gate: heuristic first, LLM only on ambiguous.
  // Mirrors the production pipeline's two-stage gate so debug-cost shape
  // matches production. Pass classifier context (current_topic +
  // open_questions) from the rolling summary so a fragment like "in the
  // app and where in the code base are they" is judged in-context as a
  // coherent continuation rather than as isolated filler.
  const heuristic = classifyRelevanceHeuristic(p.utteranceText);
  if (heuristic === 'clearly_filler') {
    args.logger.info(
      { traceId, utteranceId: p.utteranceId, relevance: heuristic },
      'local-debug.relevance.skip.filler',
    );
    send(socket, { type: 'retrieval-skip', reason: 'heuristic-filler', traceId, utteranceId: p.utteranceId });
    return;
  }
  if (heuristic === 'ambiguous') {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), RELEVANCE_TIMEOUT_MS);
    try {
      const result = await relevanceClassifier.classify(p.utteranceText, {
        signal: controller.signal,
        ...(p.lastSummary !== null && {
          context: {
            current_topic: p.lastSummary.current_topic,
            open_questions: p.lastSummary.open_questions,
          },
        }),
      });
      if (result.decision === 'skip' && result.confidence >= RELEVANCE_SKIP_THRESHOLD) {
        args.logger.info(
          {
            traceId,
            utteranceId: p.utteranceId,
            confidence: result.confidence,
            reason: result.reason,
            hadContext: p.lastSummary !== null,
          },
          'local-debug.relevance.skip.llm',
        );
        send(socket, {
          type: 'retrieval-skip',
          reason: 'classifier-skip',
          traceId,
          utteranceId: p.utteranceId,
          confidence: result.confidence,
        });
        return;
      }
    } catch (err) {
      // Fail-open: classifier error doesn't block retrieval. Log and continue.
      args.logger.warn(
        { traceId, err: String(err), utteranceId: p.utteranceId },
        'local-debug.relevance.llm.failed',
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (abortSignal.aborted) {
      args.logger.info({ traceId }, 'local-debug.pipeline.aborted.post-relevance');
      return;
    }
  }

  // ── Embed
  // Optional key_terms boost: append project nouns the rolling summary
  // extracted so short follow-up utterances ("about that auth flow")
  // carry the topic vocabulary into the embedding. Env-gated default-
  // off; see KEY_TERMS_BOOST_ENABLED comment for rationale.
  const keyTermsBoost =
    KEY_TERMS_BOOST_ENABLED &&
    p.lastSummary !== null &&
    p.lastSummary.key_terms.length > 0
      ? ` ${p.lastSummary.key_terms.join(' ')}`
      : '';
  const embedText = p.utteranceText + keyTermsBoost;
  send(socket, { type: 'embed-start', utteranceId: p.utteranceId, traceId });
  const embedStartMs = Date.now();
  const embedResult = await embedder.embed({
    items: [{ text: embedText, domain: 'text' }],
  });
  args.logger.info(
    { traceId, latencyMs: Date.now() - embedStartMs },
    'local-debug.embed.done',
  );
  if (abortSignal.aborted) {
    args.logger.info({ traceId }, 'local-debug.pipeline.aborted.post-embed');
    return;
  }
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) {
    send(socket, { type: 'retrieval-skip', reason: 'embed_no_vector', traceId });
    return;
  }

  // ── Hybrid search via the existing RPC
  const queryLiteral = `[${Array.from(vec).join(',')}]`;
  const { data: vectorRows, error: searchErr } = (await args.db.rpc('search_corpus_vector', {
    p_org_id: args.orgId,
    p_query_vector: queryLiteral,
    p_limit: TOP_K,
  })) as { data: { chunk_id: string; distance: number }[] | null; error: { message: string } | null };
  if (searchErr !== null) {
    send(socket, { type: 'retrieval-skip', reason: 'search_failed', traceId, detail: searchErr.message });
    return;
  }
  const hits = vectorRows ?? [];
  if (hits.length === 0) {
    send(socket, { type: 'retrieval-skip', reason: 'no_hits', traceId });
    return;
  }

  // ── Enrich with chunk + doc metadata
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

  // ── Build per-rank source list + emit card events
  const sources: SynthesisSource[] = [];
  const cardIds: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const chunk = chunkById.get(hit.chunk_id);
    if (chunk === undefined) continue;
    const doc = docById.get(chunk.doc_id);
    if (doc === undefined) continue;
    const cardId = `dbg_${randomUUID()}`;
    cardIds.push(cardId);
    sources.push({ rank: i + 1, title: doc.title, text: chunk.text });
    send(socket, {
      type: 'card',
      traceId,
      utteranceId: p.utteranceId,
      cardId,
      rank: i + 1,
      docId: chunk.doc_id,
      title: doc.title,
      source: doc.source,
      docType: doc.type,
      url: doc.url,
      snippet: chunk.text.slice(0, 400),
      body: chunk.text,
      distance: hit.distance,
    });
  }
  if (sources.length === 0) {
    send(socket, { type: 'retrieval-skip', reason: 'enrichment_empty', traceId });
    return;
  }

  if (abortSignal.aborted) {
    args.logger.info({ traceId }, 'local-debug.pipeline.aborted.post-cards');
    return;
  }

  // Decide whether this synthesis REPLACES the prior card or stands
  // alone. Trigger: high source-set overlap with the prior + within
  // the replacement window. The page receives `replacesSynthesisId`
  // on synthesisStart and swaps in place rather than stacking.
  let replacesSynthesisId: string | null = null;
  if (
    p.priorSynth !== null &&
    Date.now() - p.priorSynth.completedAt < REPLACE_WINDOW_MS &&
    jaccard(cardIds, p.priorSynth.sourceCardIds) >= REPLACE_JACCARD_THRESHOLD
  ) {
    replacesSynthesisId = p.priorSynth.synthesisId;
  }

  // ── Synthesize, stream textDeltas, parse on done
  args.logger.info(
    {
      traceId,
      synthesisId,
      sources: sources.length,
      totalSourceChars: sources.reduce((n, s) => n + s.text.length, 0),
      recentContextSize: p.recentContext.length,
      replacesSynthesisId,
    },
    'local-debug.synthesis.start',
  );
  send(socket, {
    type: 'synthesisStart',
    synthesisId,
    sourceCardIds: cardIds,
    traceId,
    utteranceId: p.utteranceId,
    ...(replacesSynthesisId !== null ? { replacesSynthesisId } : {}),
  });

  let accumulated = '';
  let deltaCount = 0;
  let sawStart = false;
  let sawDone = false;
  const synthStartMs = Date.now();
  try {
    for await (const chunk of synthesizer.synthesize(
      {
        utterance: p.utteranceText,
        sources,
        ...(p.recentContext.length > 0 ? { recentContext: p.recentContext } : {}),
      },
      abortSignal,
    )) {
      if (abortSignal.aborted) {
        args.logger.info({ traceId, deltaCount }, 'local-debug.synthesis.aborted');
        return;
      }
      if (chunk.type === 'start') {
        sawStart = true;
        args.logger.info(
          { traceId, model: chunk.model, inputTokens: chunk.usage.inputTokens, cacheRead: chunk.usage.cacheReadTokens },
          'local-debug.synthesis.upstream-start',
        );
      } else if (chunk.type === 'textDelta') {
        deltaCount += 1;
        accumulated += chunk.delta;
        send(socket, { type: 'synthesisDelta', synthesisId, delta: chunk.delta });
      } else if (chunk.type === 'done') {
        sawDone = true;
        const parsed = parseSynthesisOutput(accumulated, sources.length);
        const richCitations = parsed.citations.flatMap((c) => {
          const cardId = cardIds[c.rank - 1];
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
        args.logger.info(
          {
            traceId,
            synthesisId,
            latencyMs: Date.now() - synthStartMs,
            deltaCount,
            outputChars: accumulated.length,
            isRefusal: parsed.isRefusal,
            citationCount: richCitations.length,
            stopReason: chunk.stopReason,
            usage: chunk.usage,
          },
          'local-debug.synthesis.done',
        );
        send(socket, {
          type: parsed.isRefusal ? 'synthesisRefusal' : 'synthesisDone',
          synthesisId,
          stopReason: chunk.stopReason,
          accumulatedText: accumulated,
          citations: richCitations,
          usage: chunk.usage,
        });
        // Notify caller so it can update its priorSynth tracker. Skip
        // for refusals — they shouldn't form the basis for "replaces
        // this card" comparisons on the next synthesis.
        if (!parsed.isRefusal) {
          p.onComplete(cardIds);
        }
        return;
      }
    }
    // for-await fell through without seeing 'done' — that's a stream
    // close mid-flight (the most likely cause of the user-reported
    // "stuck at The" symptom). Surface it loudly so we don't silently
    // wedge.
    args.logger.warn(
      {
        traceId,
        synthesisId,
        sawStart,
        sawDone,
        deltaCount,
        accumulatedSoFar: accumulated.slice(0, 200),
        latencyMs: Date.now() - synthStartMs,
      },
      'local-debug.synthesis.stream-ended-without-done',
    );
    send(socket, {
      type: 'synthesisError',
      synthesisId,
      message: `Stream ended after ${String(deltaCount)} delta(s) without a done event`,
    });
  } catch (err) {
    if (abortSignal.aborted) {
      args.logger.info({ traceId, deltaCount }, 'local-debug.synthesis.aborted.catch');
      return;
    }
    args.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        traceId,
        synthesisId,
        deltaCount,
        accumulatedSoFar: accumulated.slice(0, 200),
      },
      'local-debug.synthesis.error',
    );
    send(socket, {
      type: 'synthesisError',
      synthesisId,
      message: (err as Error).message,
    });
  }
}

function forwardUtterance(socket: WebSocket, utt: Utterance): void {
  send(socket, {
    type: 'utterance',
    text: utt.text,
    isFinal: utt.isFinal,
    utteranceId: utt.utteranceId,
    revision: utt.revision,
    at: Date.now(),
  });
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== 1) return; // OPEN
  socket.send(JSON.stringify(payload));
}

function defaultSidecarPath(): string {
  // RISEZOME_SIDECAR_PATH env var wins when set.
  const fromEnv = process.env.RISEZOME_SIDECAR_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  // Walk up from this source file's location to find the repo root
  // (the directory containing the `sidecars/` folder). pnpm's dev
  // script sets cwd to apps/bot-worker/, not the repo root, so a
  // naive cwd-relative resolution misses by one directory.
  //
  // .../apps/bot-worker/src/debug/local-debug-ws.ts → walk up to
  // .../risezome/ (5 hops), then sidecars/linux/build/risezome-sidecar-linux.
  const here = fileURLToPath(import.meta.url);
  let dir = resolve(here, '..');
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'sidecars/linux/build/risezome-sidecar-linux');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: cwd-relative. If we land here the resulting error
  // message ("ENOENT … apps/bot-worker/sidecars/…") is the signal
  // that walk-up found nothing — set RISEZOME_SIDECAR_PATH or build
  // the sidecar binary at sidecars/linux/build/risezome-sidecar-linux.
  return resolve(process.cwd(), 'sidecars/linux/build/risezome-sidecar-linux');
}

async function computeFileSha256(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  return new Promise((resolveSha, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolveSha(hash.digest('hex')));
    stream.on('error', reject);
  });
}
