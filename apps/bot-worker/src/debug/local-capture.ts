/**
 * Local-audio meeting capture (dev only) — security/dogfood tooling.
 *
 * Captures a REAL meeting from the local microphone sidecar instead of a
 * Recall.ai bot, driving the EXACT production per-utterance path: each finalized
 * utterance is persisted as a `transcript.data` event and run through
 * `maybeRetrieveAndEmit` (apps/bot-worker/src/retrieval.ts) — the same call the
 * Recall WS handler makes in `handleMessage` (apps/bot-worker/src/index.ts). So
 * cards/syntheses/transcript persist to the meeting and broadcast on
 * `meeting:${orgId}:${meetingId}` exactly like a Recall meeting; the ONLY
 * difference is the audio source.
 *
 * This reuses, never forks: the sidecar plumbing comes from local-debug-ws.ts
 * (`SidecarRunner` + `DeepgramTranscriptionEngine` + the sidecar-path helpers),
 * and the pipeline comes from `maybeRetrieveAndEmit`. The dev console drives
 * start/stop over the bot-worker's BOT_WORKER_SECRET-guarded HTTP control surface
 * (registered in index.ts). One capture at a time (one mic).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VoyageEmbedder } from '@risezome/engine/embed';
import type { Synthesizer } from '@risezome/engine/synthesize';
import type { Summarizer } from '@risezome/engine/summarize';
import type { RelevanceClassifier } from '@risezome/engine/relevance';
import type { Classifier } from '@risezome/engine/router';
import type { SkillRegistry } from '@risezome/engine/skills';
import type { AudioFrame } from '@risezome/shared-types';
import { SidecarRunner } from './sidecar-runner.js';
import { DeepgramTranscriptionEngine } from './deepgram.js';
import { defaultSidecarPath, computeFileSha256 } from './local-debug-ws.js';
import { MeetingSummarizerRuntime } from '../summarizer-runtime.js';
import { persistAndBroadcast, broadcastOnly, utteranceToEventPayload } from '../db.js';
import { transcriptLogFields } from '../transcript-log.js';
import { recordMiss } from '../gap-capture.js';
import { maybeRetrieveAndEmit, newRetrievalRuntime, type RetrievalRuntime } from '../retrieval.js';

export interface CaptureLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/** The process-singleton deps the bot-worker already builds in `main()`. Local
 *  capture borrows the same instances — it does not rebuild any of them. */
export interface LocalCaptureDeps {
  readonly db: SupabaseClient;
  readonly embedder: VoyageEmbedder | null;
  readonly synthesizer: Synthesizer | null;
  readonly relevanceClassifier: RelevanceClassifier | null;
  readonly classifier: Classifier | null;
  readonly skillRegistry: SkillRegistry;
  /** The shared summarizer instance (per-meeting runtime is built here). */
  readonly summarizer: Summarizer | null;
  readonly deepgramKey: string;
  readonly logger: CaptureLogger;
  /** Override the sidecar binary path (tests / non-default builds). */
  readonly sidecarPath?: string;
}

interface ActiveCapture {
  readonly meetingId: string;
  readonly orgId: string;
  readonly runner: SidecarRunner;
  readonly engine: DeepgramTranscriptionEngine;
  readonly retrieval: RetrievalRuntime;
  readonly summarizerRuntime: MeetingSummarizerRuntime | null;
}

// One mic → one capture at a time (KTD5). Module singleton.
let active: ActiveCapture | null = null;

/**
 * Throttle window for interim (partial) transcript broadcasts. Deepgram emits
 * partials many times per second; we cap to ≤4/sec (one per 250ms). Dropping the
 * intermediate partials is harmless — each one supersedes the last, and the
 * final always lands. Mirrors the Recall path's INTERIM_THROTTLE_MS.
 */
const INTERIM_THROTTLE_MS = 250;

/** The meetingId of the active local capture, or null. */
export function activeLocalCapture(): string | null {
  return active?.meetingId ?? null;
}

/**
 * Start capturing a real meeting from the local sidecar. Rejects if a capture is
 * already running. On success the sidecar streams mic audio → Deepgram → the
 * production pipeline bound to `meetingId`/`orgId`.
 */
export async function startLocalCapture(
  meetingId: string,
  orgId: string,
  deps: LocalCaptureDeps,
): Promise<void> {
  if (active !== null) {
    throw new LocalCaptureBusyError(active.meetingId);
  }

  const sidecarPath = deps.sidecarPath ?? defaultSidecarPath();
  const sha = await computeFileSha256(sidecarPath);
  const runner = new SidecarRunner({
    sidecarPath,
    manifest: { [sidecarPath]: { sha256: sha } },
    args: ['--role=system'],
  });
  const engine = new DeepgramTranscriptionEngine({ apiKey: deps.deepgramKey });
  const retrieval = newRetrievalRuntime();
  const summarizerRuntime =
    deps.summarizer !== null
      ? new MeetingSummarizerRuntime({
          summarizer: deps.summarizer,
          onSummaryUpdated: (s, at) =>
            deps.logger.info(
              { meetingId, currentTopic: s.current_topic, openQuestions: s.open_questions.length, at },
              'local-capture.summary.updated',
            ),
          onSummarizerError: (err) =>
            deps.logger.warn({ meetingId, err: String(err) }, 'local-capture.summarizer.error'),
        })
      : null;

  // Register as active BEFORE wiring/start so a concurrent start is rejected.
  active = { meetingId, orgId, runner, engine, retrieval, summarizerRuntime };

  runner.on('frame', (frame: AudioFrame) => engine.sendFrame(frame.samples));
  runner.on('error', (err: Error) =>
    deps.logger.error({ meetingId, err: err.message }, 'local-capture.sidecar.error'),
  );
  engine.on('error', (err: Error) =>
    deps.logger.error({ meetingId, err: err.message }, 'local-capture.deepgram.error'),
  );

  // ── Live transcript wire contract (for the portal / hud-ui side) ──────────
  // Event:     `transcript.partial_data`
  // Transient: NEVER persisted (broadcastOnly — no meeting_events row, no
  //            encryption-at-rest). Display-only; superseded by the final.
  // Payload:   SAME shape as `transcript.data` (utteranceToEventPayload) but
  //            with isFinal:false.
  // utteranceId: a STABLE per-speech id that the Deepgram engine reuses across
  //            every partial of a speech AND its final (deepgram.ts pins
  //            #currentUtteranceId on the first partial, resets on final). So
  //            the final's persisted `transcript.data` carries the SAME id and
  //            the client upserts-by-id — the final REPLACES the interim line
  //            rather than appending a duplicate.
  // revision:  monotonically increasing per speech (engine #currentRevision),
  //            so a stale/equal-revision partial can be rejected client-side;
  //            a final always wins regardless of revision.
  // The client must dispatch `transcript.partial_data` ONLY from the live
  // broadcast — never replay it on the reconnect/poll path (it is transient and
  // absent from meeting_events).
  //
  // Throttle: only the FIRST partial within each INTERIM_THROTTLE_MS window is
  // broadcast; lastPartialBroadcastAt resets to 0 on each final so the next
  // speech's first partial broadcasts immediately.
  let lastPartialBroadcastAt = 0;
  engine.on('partial', (t) => {
    const text = t.utterance.text.trim();
    if (text.length === 0) return; // skip empty interims
    const now = Date.now();
    if (now - lastPartialBroadcastAt < INTERIM_THROTTLE_MS) return; // throttled; next supersedes
    lastPartialBroadcastAt = now;
    // Transient broadcast: NO persist, NO retrieval. Fire-and-forget; a dropped
    // partial is harmless (the next one — or the final — supersedes it).
    void broadcastOnly(deps.db, {
      meetingId,
      orgId,
      type: 'transcript.partial_data',
      payload: utteranceToEventPayload(t.utterance),
    });
    deps.logger.info(
      {
        meetingId,
        revision: t.utterance.revision,
        speaker: t.utterance.speaker,
        // Transcript body redacted by default (U6); verbatim only under LOG_TRANSCRIPTS=1.
        ...transcriptLogFields(t.utterance.text),
      },
      'local-capture.partial',
    );
  });

  // Only FINAL utterances persist + drive retrieval (mirrors the Recall path).
  // Resetting the throttle here lets the next speech's first partial broadcast
  // immediately rather than waiting out a window from the prior speech.
  engine.on('final', (t) => {
    lastPartialBroadcastAt = 0;
    void onFinalUtterance(meetingId, orgId, retrieval, summarizerRuntime, t.utterance, deps);
  });

  try {
    await engine.start();
    await runner.start();
  } catch (err) {
    // Start failed — tear down and clear so the next Start can retry (no zombie).
    active = null;
    summarizerRuntime?.dispose();
    await runner.stop().catch(() => undefined);
    await engine.stop().catch(() => undefined);
    throw err;
  }

  deps.logger.info({ meetingId, orgId, sidecarPath }, 'local-capture.started');
}

/**
 * Stop the active local capture for `meetingId`. Returns false if no matching
 * capture is running. Tears down the sidecar, Deepgram, and the summarizer.
 */
export async function stopLocalCapture(meetingId: string, logger?: CaptureLogger): Promise<boolean> {
  if (active?.meetingId !== meetingId) return false;
  const a = active;
  active = null;
  a.summarizerRuntime?.dispose();
  await a.runner.stop().catch(() => undefined);
  await a.engine.stop().catch(() => undefined);
  logger?.info({ meetingId }, 'local-capture.stopped');
  return true;
}

/**
 * Per-finalized-utterance handling — a faithful copy of the Recall handler's
 * FINAL branch (apps/bot-worker/src/index.ts `handleMessage`): persist the
 * transcript event, then run the retrieval/synthesis pipeline bound to the
 * meeting. Sourced from the sidecar instead of the Recall WS.
 */
async function onFinalUtterance(
  meetingId: string,
  orgId: string,
  retrieval: RetrievalRuntime,
  summarizerRuntime: MeetingSummarizerRuntime | null,
  utterance: Parameters<typeof utteranceToEventPayload>[0],
  deps: LocalCaptureDeps,
): Promise<void> {
  const text = utterance.text.trim();
  if (text.length === 0) return;

  // Persist + broadcast the transcript event (transcript_text_enc via KMS). The
  // Recall path does this; the debug WS path does NOT — without it Review shows
  // cards/syntheses but no transcript.
  try {
    await persistAndBroadcast(deps.db, {
      meetingId,
      orgId,
      type: 'transcript.data',
      payload: utteranceToEventPayload(utterance),
    });
  } catch (err) {
    deps.logger.warn({ meetingId, err: String(err) }, 'local-capture.transcript.persist.failed');
  }

  if (deps.embedder === null) return;

  if (summarizerRuntime !== null) summarizerRuntime.recordUtterance(text);
  const lastSummary = summarizerRuntime !== null ? summarizerRuntime.getLastSummary() : null;

  await maybeRetrieveAndEmit({
    runtime: retrieval,
    utteranceText: text,
    utteranceId: utterance.utteranceId,
    meetingId,
    orgId,
    db: deps.db,
    embedder: deps.embedder,
    ...(deps.synthesizer !== null ? { synthesizer: deps.synthesizer } : {}),
    ...(deps.relevanceClassifier !== null ? { relevanceClassifier: deps.relevanceClassifier } : {}),
    ...(deps.classifier !== null ? { classifier: deps.classifier } : {}),
    skillRegistry: deps.skillRegistry,
    ...(lastSummary !== null ? { lastSummary } : {}),
    ...(summarizerRuntime !== null
      ? { onGroundedAnswer: (answer: string) => summarizerRuntime.recordAssistantAnswer(answer) }
      : {}),
    ...(summarizerRuntime !== null
      ? { onSynthesisRequested: () => summarizerRuntime.refreshIfStale() }
      : {}),
    onMiss: (miss) => {
      void recordMiss(deps.db, miss, deps.logger);
    },
    logger: deps.logger,
  }).catch((err: unknown) => {
    deps.logger.warn({ meetingId, err: String(err) }, 'local-capture.pipeline.error');
  });
}

/** Thrown when a Start arrives while a local capture is already running (KTD5). */
export class LocalCaptureBusyError extends Error {
  constructor(public readonly activeMeetingId: string) {
    super(`local capture already active for meeting ${activeMeetingId}`);
    this.name = 'LocalCaptureBusyError';
  }
}

/** Test-only reset of the module singleton (between cases). */
export function __resetLocalCaptureForTest(): void {
  active = null;
}
