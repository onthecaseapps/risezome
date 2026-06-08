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
import { AnthropicSynthesizer } from '@risezome/engine/synthesize';
import { AnthropicSummarizer } from '@risezome/engine/summarize';
import { AnthropicRelevanceClassifier } from '@risezome/engine/relevance';
import { AnthropicClassifier } from '@risezome/engine/router';
import type { AudioFrame } from '@risezome/shared-types';
import type { Utterance } from '@risezome/engine/transcribe';
import { MeetingSummarizerRuntime } from '../summarizer-runtime.js';
import { buildSkillRegistry } from '../skills/index.js';
import { createWsSink } from '../pipeline/sink-ws.js';
import { maybeRetrieveAndEmit, newRetrievalRuntime } from '../retrieval.js';
import { skipReasonToTrace } from './gate-skip-trace.js';

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

const SYNTHESIS_MAX_TOKENS = 200;

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

  // Per-WS retrieval state. The dev sidecar now routes EVERY finalized utterance
  // through the SAME prod adapter (`maybeRetrieveAndEmit`), so all gate/dedup
  // state — recentFinals, consumedFinals, answeredSourceSets, answeredQuestions,
  // cooldown, and the question ceiling — lives on this `RetrievalRuntime`, owned
  // by the adapter. Reset on `replay-reset` (a fresh runtime). Single code path
  // ⇒ the debug page reflects the live pipeline's answer/suppress decision
  // exactly (U3).
  let runtime = newRetrievalRuntime();
  // KTD4/U4: the real meeting being replayed (set on `replay-reset`). When set,
  // retrieval scopes to that meeting's effective source set (parity); when null
  // (live-mic, or a file-loaded transcript) retrieval runs whole-org / unscoped.
  let replayMeetingId: string | null = null;

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

  // Per-utterance pipeline trigger. Routes EVERY finalized utterance (live
  // Deepgram final OR replayed `replay-utterance`) through the SAME prod adapter
  // (`maybeRetrieveAndEmit`) so the debug page reflects the live pipeline's
  // answer/suppress decision exactly — the full gate stack (two-lane
  // classification, near-dup-question suppression, per-minute/per-meeting
  // ceiling, cooldown, threshold, source-set scope) runs in ONE place (U3).
  //
  // `opts.now` is the injected logical clock: the live path passes nothing (the
  // adapter defaults to Date.now() — wall-clock, matching prod live); the replay
  // path passes the meeting-logical `startMs` so the replay's compressed
  // wall-clock can't distort the time-based gates.
  const handleFinalUtterance = (utterance: Utterance, opts?: { now?: number }): void => {
    forwardUtterance(socket, utterance);
    const text = utterance.text.trim();
    if (text.length === 0) return;

    // Feed the summarizer runtime — fires asynchronously when cadence + rate-cap
    // conditions hold. Its onSummaryUpdated broadcasts a `summary` WS event.
    summarizerRuntime.recordUtterance(text);

    // A synthesis may be about to fire → lazily refresh the rolling summary if
    // stale (demand-driven; async, benefits the next utterance). Read lastSummary
    // AFTER, atomically, so this call's context is the prior one.
    summarizerRuntime.refreshIfStale();
    const lastSummary = summarizerRuntime.getLastSummary() ?? undefined;

    // Stable id the WS sink rewrites every synthesis event onto, so the page's
    // synthesis rendering keys on a single id per utterance.
    const synthesisId = `synth_${randomUUID()}`;
    const now = opts?.now;

    void maybeRetrieveAndEmit({
      runtime,
      utteranceText: text,
      utteranceId: utterance.utteranceId,
      // KTD4/U4: replaying a real meeting scopes retrieval to that meeting's
      // effective source set (parity); live-mic / file-loaded (replayMeetingId
      // null) runs whole-org / unscoped. orgId always doubles as the org scope.
      meetingId: replayMeetingId ?? args.orgId,
      orgId: args.orgId,
      db: args.db,
      embedder,
      synthesizer,
      relevanceClassifier,
      // The adapter names the router classifier arg `classifier`.
      classifier: routerClassifier,
      skillRegistry,
      ...(lastSummary !== undefined ? { lastSummary } : {}),
      logger: args.logger,
      ...(now !== undefined ? { now } : {}),
      unscoped: replayMeetingId === null,
      // WS+trace sink: maps every core result onto the existing local-debug WS
      // events and emits the per-stage `trace`. The sink's onGroundedAnswer is
      // the adapter's runtime-recording hook (`wiring.onGroundedAnswer`) so dedup
      // state (answeredQuestions/consumedFinals/answeredSourceSets) records.
      // Close-the-loop (recordAssistantAnswer) rides the sink's onComplete, which
      // fires once on a grounded synthesisDone — wired here exactly once, so the
      // adapter-level onGroundedAnswer is omitted to avoid double-recording.
      createSink: (wiring) =>
        createWsSink({
          socket,
          synthesisId,
          logger: args.logger,
          onComplete: (answerText) => summarizerRuntime.recordAssistantAnswer(answerText),
          onGroundedAnswer: wiring.onGroundedAnswer,
        }),
    })
      .then((res) => {
        // A pre-pipeline gate skip (throttle / near-dup / threshold) emits no
        // core trace, so translate it into a single-stage trace event (KTD1) —
        // else the page shows "no trace" for a suppressed utterance. A fired or
        // core-originated skip returns null (the core already traced it).
        const traceEvt = skipReasonToTrace(res.skipped, {
          traceId: `gate_${utterance.utteranceId}`,
          utteranceId: utterance.utteranceId,
          meetingId: args.orgId,
          // The adapter owns the real prior-context window; [] is acceptable here.
          priorContext: [],
        });
        if (traceEvt !== null) send(socket, { ...traceEvt });
      })
      .catch((err: unknown) => {
        args.logger.warn({ err: String(err) }, 'local-debug.pipeline.error');
        send(socket, { type: 'pipeline-error', message: String(err) });
      });
  };

  // Clear per-connection replay state between runs so successive replays don't
  // bleed gate/dedup/cooldown state. A fresh runtime resets everything the
  // adapter owns. Per-utterance abort is gone (prod doesn't abort — parity
  // intent), so there's nothing else to tear down; the page clears client-side
  // on reset. The rolling summarizer is intentionally left to age out on its own.
  const resetReplayState = (meetingId: string | null): void => {
    runtime = newRetrievalRuntime();
    replayMeetingId = meetingId;
    // KTD4/U4: tell the page the retrieval scope for this run so the trace +
    // summary can label it ("scoped to meeting …" vs "unscoped (no meeting)").
    send(socket, {
      type: 'replay-scope',
      scoped: meetingId !== null,
      meetingId,
    });
  };

  // Live mic path: Deepgram finals drive the shared handler with wall-clock time
  // (no opts ⇒ the adapter defaults to Date.now(), matching prod live).
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
      resetReplayState(msg.meetingId);
      return;
    }
    // Replay supplies the meeting-logical clock (startMs) so the adapter's
    // time-based gates read logical time, not the replay's compressed wall-clock.
    handleFinalUtterance(msg.utterance, { now: msg.utterance.startMs });
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
  // KTD4/U4: `replay-reset` optionally carries the real meeting id being
  // replayed, so retrieval scopes to that meeting's effective source set
  // (parity). Absent ⇒ whole-org / unscoped (live-mic or a file-loaded
  // transcript with no meeting).
  | { readonly kind: 'reset'; readonly meetingId: string | null };

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
  if (m.type === 'replay-reset') {
    const meetingId =
      typeof m.meetingId === 'string' && m.meetingId.length > 0 ? m.meetingId : null;
    return { kind: 'reset', meetingId };
  }
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
