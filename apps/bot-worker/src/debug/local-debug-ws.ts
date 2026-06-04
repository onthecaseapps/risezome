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
    const isContinuation =
      recentFinals.length >= 2 &&
      looksLikeContinuation(
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
    // A synthesis is about to fire → lazily refresh the rolling summary if
    // stale (demand-driven; async, benefits the next utterance). Read
    // lastSummary AFTER, atomically, so this call's context is the prior one.
    summarizerRuntime.refreshIfStale();
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
      utteranceId: t.utterance.utteranceId,
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
  };

  // ── WS sink: maps every core result onto the existing local-debug events and
  // adds the `trace` event (dev = trace ON).
  const sink = createWsSink({
    socket,
    synthesisId: p.synthesisId,
    logger: args.logger,
    onComplete: p.onComplete,
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

function defaultSidecarPath(): string {
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
