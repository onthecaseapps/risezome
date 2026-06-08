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
import { logTranscripts } from '../transcript-log.js';
import { VoyageEmbedder } from '@risezome/engine/embed';
import { AnthropicSynthesizer } from '@risezome/engine/synthesize';
import { hybridSearch, isLowConfidenceHits } from '../corpus-search';
import { optionalReranker } from '../reranker';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc } from '../parent-doc';
import { optionalQueryExpander } from '../query-expand';
import { AnthropicSummarizer, type MeetingSummary } from '@risezome/engine/summarize';
import {
  AnthropicRelevanceClassifier,
  type RelevanceClassifier,
} from '@risezome/engine/relevance';
import { AnthropicClassifier, type Classifier } from '@risezome/engine/router';
import { type SkillRegistry } from '@risezome/engine/skills';
import type { AudioFrame } from '@risezome/shared-types';
import type { Utterance } from '@risezome/engine/transcribe';
import { MeetingSummarizerRuntime } from '../summarizer-runtime.js';
import { buildSkillRegistry } from '../skills/index.js';
import { runPipeline } from '../pipeline/core.js';
import type { PipelineDeps, PipelineInput } from '../pipeline/contract.js';
import { createWsSink } from '../pipeline/sink-ws.js';
import {
  effectiveWindow,
  isDuplicateAnswerSourceSet,
  addConsumedFinals,
  CONSUMED_FINALS_CAP,
  QUESTION_DUP_WINDOW_MS,
} from '../pipeline/answer-dedup.js';

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

// Dev-only TOP_K — the broader recall the dev page intentionally used (the
// canonical core default is also 5; passed explicitly via deps.topK).
const TOP_K = 5;
const SYNTHESIS_MAX_TOKENS = 200;

// U3 strict "about-our-work" routing — route `clearly_substantive` through the
// LLM judge too, not just `ambiguous`. Read from the SAME env var as the prod
// Recall path (apps/bot-worker/src/retrieval.ts) so the dev sidecar and prod
// make the same surface/suppress decision for a given utterance (the gate lives
// in the shared core).
const RELEVANCE_STRICT = process.env.RISEZOME_RELEVANCE_STRICT === 'true';

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

const CONTINUATION_LEADERS = new Set([
  'and',
  'but',
  'or',
  'so',
  'in',
  'on',
  'at',
  'of',
  'to',
  'for',
  'with',
  'from',
  'where',
  'when',
  'how',
  'why',
  'which',
  'who',
  'because',
  'since',
  'while',
  'that',
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
    send(socket, {
      type: 'error',
      message: `sidecar init failed: ${String((err as Error).message)}`,
    });
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
  // Router classifier + skill registry — mirrors the production Recall
  // path (apps/bot-worker/src/retrieval.ts). Without this the debug
  // page can never route "how many open issues" to github_count; every
  // utterance goes straight to vector RAG. The registry is rebuilt per
  // WS connection (cheap; reads env vars once).
  const routerClassifier = new AnthropicClassifier({
    apiKey: args.anthropicKey,
    model: args.anthropicModel,
  });
  const skillRegistry = buildSkillRegistry({ db: args.db, logger: args.logger });
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
  let currentSynthesisAbort: AbortController | null = null;
  let currentSynthesisId: string | null = null;
  const recentFinals: { text: string; at: number }[] = [];

  // Mechanism A/B per-connection dedup state, mirroring `RetrievalRuntime` on the
  // prod path. `consumedFinals` — answered transcript spans voided from the
  // effective window so they can't re-seed the next query. `answeredSourceSets` —
  // grounded source-doc sets answered this session (+ timestamp), recency-pruned,
  // so a question retrieving the same set is skipped before cards emit. Mutated in
  // place (the closures below need stable references).
  const consumedFinals: string[] = [];
  const answeredSourceSets: { docIds: string[]; at: number }[] = [];

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

  // Per-utterance pipeline trigger. Extracted (U1) so BOTH the live Deepgram-
  // final path and the transcript-replay inbound (`replay-utterance`) drive the
  // EXACT same gate / voiding / continuation-merge / pipeline logic. Closes over
  // the per-connection state above.
  const handleFinalUtterance = (utterance: Utterance): void => {
    forwardUtterance(socket, utterance);
    const text = utterance.text.trim();
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

    // Mechanism A: derive the EFFECTIVE window — recentFinals with any
    // already-answered span (in `consumedFinals`) voided, but the current
    // utterance (last element) always kept. Captured in this closure so the
    // grounded callback below can mark exactly these spans consumed once an
    // answer grounds. The raw `recentFinals` rolling buffer is untouched.
    const effective = effectiveWindow(
      recentFinals.map((f) => f.text),
      consumedFinals,
    );

    // Heuristic fragment merge: if the prior final landed within
    // CONTINUATION_WINDOW_MS and the new utterance looks like a
    // continuation (lowercase start, or starts with a connective like
    // "and", "but", "in", "where"), treat the new utterance as
    // extending the prior one. Effective query = concat. We still pass
    // the full recent context as a backstop in case the heuristic is
    // wrong. Mechanism A: a CONSUMED prior fragment must NOT seed the next
    // query, so only merge when the prior final hasn't been answered already.
    const priorFinal =
      recentFinals.length >= 2 ? recentFinals[recentFinals.length - 2]! : undefined;
    const isContinuation =
      priorFinal !== undefined &&
      !consumedFinals.includes(priorFinal.text) &&
      looksLikeContinuation(priorFinal, recentFinals[recentFinals.length - 1]!);
    const effectiveUtterance = isContinuation
      ? `${priorFinal.text} ${text}`
      : text;

    // Build recentContext for the synthesizer. The latest rolling
    // summary prose (if any) goes at the head as the OLDEST entry
    // (longest-range context); the recent finals follow in oldest-
    // first order. Reads lastSummary ONCE here (synchronously, before
    // the pipeline starts) so a mid-stream summary refresh can't
    // produce a torn read — the in-flight call keeps the summary it
    // captured at start; the next call picks up the new one.
    // A synthesis is about to fire → lazily refresh the rolling summary if
    // stale (demand-driven; async, benefits the next utterance). Read
    // lastSummary AFTER, atomically, so this call's context is the prior one.
    summarizerRuntime.refreshIfStale();
    const lastSummaryAtBuild = summarizerRuntime.getLastSummary();
    // Mechanism A: the effective window (answered spans voided) excluding the
    // current utterance (which IS the query) feeds the synthesizer context.
    const recentContext = [
      ...(lastSummaryAtBuild !== null && lastSummaryAtBuild.summary.length > 0
        ? [lastSummaryAtBuild.summary]
        : []),
      ...effective.slice(0, -1),
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
        // Transcript bodies redacted by default (U6); verbatim only under LOG_TRANSCRIPTS=1.
        rawUtteranceLen: text.length,
        effectiveUtteranceLen: effectiveUtterance.length,
        ...(logTranscripts() ? { rawUtterance: text, effectiveUtterance } : {}),
        isContinuation,
        recentContextSize: recentContext.length,
        bufferSize: recentFinals.length,
      },
      'local-debug.utterance.fire',
    );

    void runDebugPipeline({
      synthesisId,
      utteranceText: effectiveUtterance,
      utteranceId: utterance.utteranceId,
      recentContext,
      lastSummary: lastSummaryAtBuild,
      socket,
      args,
      embedder,
      synthesizer,
      relevanceClassifier,
      routerClassifier,
      skillRegistry,
      abortSignal: ac.signal,
      onComplete: (answerText) => {
        // Close the loop: the grounded answer was shown, not spoken, so feed
        // it to the summarizer to retire the open question it resolved.
        summarizerRuntime.recordAssistantAnswer(answerText);
        if (currentSynthesisId === synthesisId) {
          currentSynthesisId = null;
          currentSynthesisAbort = null;
        }
      },
      // Mechanism B (read side): prune the answered-source ledger by the recency
      // window, then run the shared pure predicate. Read-only on the runtime;
      // the core checks this before emitting cards and short-circuits a dup.
      isDuplicateAnswerSources: (docIds) => {
        const nowDup = Date.now();
        // Prune in place (the array is a stable per-connection reference).
        const kept = answeredSourceSets.filter((e) => nowDup - e.at < QUESTION_DUP_WINDOW_MS);
        answeredSourceSets.length = 0;
        answeredSourceSets.push(...kept);
        return isDuplicateAnswerSourceSet(docIds, answeredSourceSets, nowDup, QUESTION_DUP_WINDOW_MS);
      },
      // Mechanism A/B (record side): once an answer grounds, void this call's
      // effective spans (so they can't re-seed the next query) and remember the
      // grounded source set (so a later same-source question is skipped). Mutate
      // the per-connection arrays in place.
      onGroundedAnswer: (_text, sourceDocIds) => {
        const groundedAt = Date.now();
        const nextConsumed = addConsumedFinals(consumedFinals, effective, CONSUMED_FINALS_CAP);
        consumedFinals.length = 0;
        consumedFinals.push(...nextConsumed);
        if (sourceDocIds.length > 0) {
          answeredSourceSets.push({ docIds: [...new Set(sourceDocIds)], at: groundedAt });
        }
      },
    }).catch((err: unknown) => {
      args.logger.warn({ err: String(err) }, 'local-debug.pipeline.error');
      send(socket, { type: 'pipeline-error', message: String(err) });
    });
  };

  // Clear per-connection replay state between runs so successive replays don't
  // bleed context (voided spans, answered source sets, in-flight synthesis).
  // Note: the rolling summarizer is intentionally left to age out on its own.
  const resetReplayState = (): void => {
    recentFinals.length = 0;
    consumedFinals.length = 0;
    answeredSourceSets.length = 0;
    if (currentSynthesisAbort !== null) {
      currentSynthesisAbort.abort();
      currentSynthesisAbort = null;
      currentSynthesisId = null;
    }
  };

  // Live mic path: Deepgram finals drive the shared handler.
  engine.on('final', (t) => {
    handleFinalUtterance(t.utterance);
  });

  // Replay path: the page sends timed `replay-utterance` messages (no audio /
  // Deepgram) and a `replay-reset` before each run. Same handler as live, so
  // replayed utterances exercise identical gate/voiding/merge/pipeline logic.
  socket.on('message', (raw) => {
    const msg = parseReplayInbound(rawToString(raw));
    if (msg === null) return;
    if (msg.kind === 'reset') {
      resetReplayState();
      return;
    }
    handleFinalUtterance(msg.utterance);
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
  /** Snapshot of the rolling summary at call-fire time. The core reads
   *  `current_topic` + `open_questions` from this for the classifier's
   *  coherence-in-context judgment, and reads `key_terms` for the embedding-
   *  query boost (env-gated). Captured by the caller ONCE at fire time so a
   *  mid-flight summary refresh can't produce a torn read. */
  readonly lastSummary: MeetingSummary | null;
  readonly socket: WebSocket;
  readonly args: LocalDebugHandlerArgs;
  readonly embedder: VoyageEmbedder;
  readonly synthesizer: AnthropicSynthesizer;
  readonly relevanceClassifier: RelevanceClassifier;
  /** Router classifier — picks `tool` vs `rag` per utterance. When it
   *  returns a tool intent, the chosen skill runs and its result is
   *  prepended to the synthesizer's sources as [1]. */
  readonly routerClassifier: Classifier;
  readonly skillRegistry: SkillRegistry;
  readonly abortSignal: AbortSignal;
  /** Called after the pipeline completes successfully (non-refusal) with the
   *  grounded answer body, so the caller can feed it to the summarizer
   *  (close-the-loop: an answered question retires from the next rolling
   *  summary). */
  readonly onComplete: (answerText: string) => void;
  /** Mechanism B (read side): injected into `deps` so the core skips a question
   *  whose grounded source set duplicates a recent answered one. */
  readonly isDuplicateAnswerSources: (docIds: readonly string[]) => boolean;
  /** Mechanism A/B (record side): invoked on a grounded answer so the handler
   *  voids this call's transcript spans + records the answered source set. */
  readonly onGroundedAnswer: (text: string, sourceDocIds: readonly string[]) => void;
}

/**
 * Per-utterance pipeline — a THIN ADAPTER onto the shared core (U3). It builds
 * `PipelineInput` (single utterance + queryText + recentContext + lastSummary)
 * and `PipelineDeps` (the same bot-worker search fns + classifiers as prod),
 * then runs `runPipeline` behind a WS sink. The dev sidecar therefore runs the
 * SAME core as production — so the U3 strict gate (`RISEZOME_RELEVANCE_STRICT`)
 * now applies here too, fixing the drift where the dev page lacked it.
 *
 * Everything pipeline-specific (relevance gate → embed → search → CRAG →
 * dedup/expand → cards → synthesis → citation-verify) lives in the core; this
 * adapter keeps ONLY the dev transcription-source plumbing (continuation merge,
 * rolling finals, abort-on-new-utterance) in the handler above. The WS sink
 * defines `recordTrace`, so the core assembles + streams a per-stage `trace`
 * event to the page (dev = trace ON; prod's sink omits recordTrace).
 */
async function runDebugPipeline(p: PipelineArgs): Promise<void> {
  const {
    socket,
    args,
    embedder,
    synthesizer,
    relevanceClassifier,
    routerClassifier,
    skillRegistry,
  } = p;

  args.logger.info(
    { synthesisId: p.synthesisId, utteranceId: p.utteranceId, text: p.utteranceText },
    'local-debug.pipeline.start',
  );

  const lastSummary = p.lastSummary ?? undefined;

  // ── Source seam: build PipelineInput. The dev sidecar embeds/searches the
  // single (continuation-merged) utterance — a legitimate per-source difference
  // from prod's rolling-window queryText (KTD).
  const input: PipelineInput = {
    utteranceText: p.utteranceText,
    utteranceId: p.utteranceId,
    meetingId: args.orgId, // dev sidecar has no meeting; org doubles as the scope id
    orgId: args.orgId,
    queryText: p.utteranceText,
    ...(p.recentContext.length > 0 ? { recentContext: p.recentContext } : {}),
    ...(lastSummary !== undefined ? { lastSummary } : {}),
  };

  // ── PipelineDeps: the same bot-worker Supabase-bound capabilities prod
  // injects. relevanceStrict comes from RISEZOME_RELEVANCE_STRICT so the dev
  // page gets the U3 about-our-work routing prod has.
  const deps: PipelineDeps = {
    db: args.db,
    embedder,
    synthesizer,
    relevanceClassifier,
    routerClassifier,
    skillRegistry,
    hybridSearch: (params) => hybridSearch(args.db, params),
    isLowConfidenceHits,
    optionalReranker,
    optionalQueryExpander,
    dedupeByDoc,
    expandWinnersToParents: (orgId, winners) =>
      expandWinnersToParents(args.db, orgId, winners),
    parentDocEnabled,
    logger: args.logger,
    relevanceStrict: RELEVANCE_STRICT,
    topK: TOP_K,
    // Mechanism B (read side): the core checks this before emitting cards and
    // short-circuits a question whose grounded source set duplicates a recent
    // answered one. Mirrors the prod Recall path.
    isDuplicateAnswerSources: p.isDuplicateAnswerSources,
  };

  // ── WS sink: maps every core result onto the existing local-debug events and
  // adds the `trace` event (dev = trace ON). Mechanism A/B record side rides the
  // sink's onGroundedAnswer (the grounded body + source docIds).
  const sink = createWsSink({
    socket,
    synthesisId: p.synthesisId,
    logger: args.logger,
    onComplete: p.onComplete,
    onGroundedAnswer: p.onGroundedAnswer,
  });

  await runPipeline(input, deps, sink);
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

/** Inbound replay control message, parsed from a WS frame. */
export type ReplayInbound =
  | { readonly kind: 'utterance'; readonly utterance: Utterance }
  | { readonly kind: 'reset' };

/** Coerce a ws RawData frame (string | Buffer | Buffer[] | ArrayBuffer) to text. */
function rawToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return '';
}

/**
 * Parse a replay control frame. Pure + exported for unit testing. Returns null
 * for anything unrecognized — malformed JSON, unknown type, or a replay-utterance
 * missing usable text / id (empty/whitespace text is dropped here, mirroring the
 * live handler's `text.length === 0` guard). A `replay-utterance` is normalized
 * into a finalized `Utterance` so it drives the same handler as a Deepgram final.
 */
export function parseReplayInbound(raw: string): ReplayInbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type === 'replay-reset') return { kind: 'reset' };
  if (m.type !== 'replay-utterance') return null;

  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const utteranceId = typeof m.utteranceId === 'string' ? m.utteranceId : '';
  if (text.length === 0 || utteranceId.length === 0) return null;
  const startMs = typeof m.startMs === 'number' && Number.isFinite(m.startMs) ? m.startMs : 0;
  const utterance: Utterance = {
    utteranceId,
    text,
    isFinal: true,
    ...(typeof m.speaker === 'string' && m.speaker.length > 0 ? { speaker: m.speaker } : {}),
    startMs,
    endMs: startMs,
    revision: 0,
  };
  return { kind: 'utterance', utterance };
}

export function defaultSidecarPath(): string {
  // RISEZOME_SIDECAR_PATH env var wins when set.
  const fromEnv = process.env.RISEZOME_SIDECAR_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  // Per-platform default binary. macOS captures via the Swift/CoreAudio sidecar
  // (BlackHole loopback for system audio); Linux via the PulseAudio C sidecar.
  const rel =
    process.platform === 'darwin'
      ? 'sidecars/macos/build/risezome-sidecar-macos'
      : 'sidecars/linux/build/risezome-sidecar-linux';

  // Walk up from this source file's location to find the repo root
  // (the directory containing the `sidecars/` folder). pnpm's dev
  // script sets cwd to apps/bot-worker/, not the repo root, so a
  // naive cwd-relative resolution misses by one directory.
  const here = fileURLToPath(import.meta.url);
  let dir = resolve(here, '..');
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: cwd-relative. If we land here the resulting error
  // message ("ENOENT …") is the signal that walk-up found nothing — set
  // RISEZOME_SIDECAR_PATH or build the sidecar binary at the path above.
  return resolve(process.cwd(), rel);
}

export async function computeFileSha256(path: string): Promise<string> {
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
