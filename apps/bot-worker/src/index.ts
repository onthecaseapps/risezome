/**
 * Bot-worker entry. Long-running Node service:
 *
 *   1. Fastify HTTP server with WS upgrade at /recall/:meetingId/:jwt
 *   2. JWT verification (signature, expiry, meeting_id binding)
 *   3. Per-meeting in-memory runtime — registered on first connect,
 *      reused on reconnect, torn down on /meetings/:id/end (HTTP)
 *   4. Adapts inbound Recall messages → engine Utterance and (for U9c)
 *      logs them. U9d wires the full engine pipeline + DB + Realtime.
 *
 * Health: GET /health returns 200 if the process is alive. Used by
 * Fly.io's healthcheck once we deploy.
 */

import Fastify from 'fastify';
import { fastifyServerOptions } from './server-options.js';
import { transcriptLogFields } from './transcript-log.js';
import { bearerMatches } from './shared-secret.js';
import websocket from '@fastify/websocket';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  AnthropicSynthesizer,
  DEFAULT_ANTHROPIC_MODEL,
  type Synthesizer,
} from '@risezome/engine/synthesize';
import { AnthropicRelevanceClassifier, type RelevanceClassifier } from '@risezome/engine/relevance';
import { AnthropicSummarizer, type Summarizer } from '@risezome/engine/summarize';
import { AnthropicClassifier, type Classifier } from '@risezome/engine/router';
import { type SkillRegistry } from '@risezome/engine/skills';
import { buildSkillRegistry } from './skills/index.js';
import { adaptRecallMessage } from './recall-adapter.js';
import { verifyBotWsJwt, type BotWsJwtPayload } from './jwt.js';
import { handleLocalDebugWs } from './debug/local-debug-ws.js';
import {
  startLocalCapture,
  stopLocalCapture,
  activeLocalCapture,
  LocalCaptureBusyError,
  type LocalCaptureDeps,
} from './debug/local-capture.js';
import { registerEvalRoutes } from './debug/eval-routes.js';
import {
  broadcastOnly,
  createServiceClient,
  markRecordingIfFirst,
  persistAndBroadcast,
  utteranceToEventPayload,
} from './db.js';
import {
  newSegmentTracker,
  resolveFinal,
  resolvePartial,
  type SegmentTracker,
} from './segment-tracker.js';
import { maybeRetrieveAndEmit, newRetrievalRuntime, type RetrievalRuntime } from './retrieval.js';
import { MeetingSummarizerRuntime } from './summarizer-runtime.js';
import { recordMiss } from './gap-capture.js';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PerMeetingRuntime {
  meetingId: string;
  orgId: string;
  /** When the first WS connect arrived. */
  connectedAt: number;
  /** Total utterances seen across reconnects. */
  utteranceCount: number;
  /** Whether we've flipped meetings.status to 'recording' yet. */
  markedRecording: boolean;
  /** Retrieval state — rolling window + throttling counters. */
  retrieval: RetrievalRuntime;
  /** Rolling-summary runtime — accumulates the transcript, fires the
   *  summarizer on cadence, exposes lastSummary for classifier-context
   *  + key_terms boost + synthesizer recentContext. Null when
   *  ANTHROPIC_API_KEY is unset (summarizer disabled). */
  summarizer: MeetingSummarizerRuntime | null;
  /** Interim-transcript segment tracker — per-participant open speech, used to
   *  pin a STABLE utteranceId across drifting partials + the final, and to
   *  throttle interim broadcasts. Cleared per-final; torn down with the
   *  runtime. See segment-tracker.ts for the pass-2 wire contract. */
  segments: SegmentTracker;
}

const runtimes = new Map<string, PerMeetingRuntime>();

async function main(): Promise<void> {
  const port = parsePort(process.env.BOT_WORKER_PORT ?? '8787');
  const secret = process.env.BOT_WORKER_SECRET;
  if (secret === undefined || secret.length === 0) {
    console.error('[bot-worker] BOT_WORKER_SECRET is required');
    process.exit(1);
  }

  const db = createServiceClient();

  // Voyage embedder for per-utterance retrieval. Optional: if
  // VOYAGE_API_KEY isn't set, retrieval is silently disabled (the
  // transcript pipeline still runs). Lets you run the bot-worker in
  // "transcript-only" dev mode without standing up Voyage.
  const voyageKey = process.env.VOYAGE_API_KEY;
  const embedder =
    voyageKey !== undefined && voyageKey.length > 0
      ? new VoyageEmbedder({ apiKey: voyageKey })
      : null;
  if (embedder === null) {
    console.warn('[bot-worker] VOYAGE_API_KEY unset — per-utterance retrieval disabled');
  }

  // Anthropic synthesizer + relevance classifier (both optional + both
  // share the same key). When ANTHROPIC_API_KEY is unset, retrieval
  // still emits cards but no synthesis or LLM-relevance runs — the
  // cheap regex heuristic alone gates filler. Useful for dev iteration
  // without burning Anthropic tokens.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicModel = process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const synthesizer: Synthesizer | null =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? new AnthropicSynthesizer({ apiKey: anthropicKey, model: anthropicModel })
      : null;
  const relevanceClassifier: RelevanceClassifier | null =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? new AnthropicRelevanceClassifier({ apiKey: anthropicKey, model: anthropicModel })
      : null;
  const summarizer: Summarizer | null =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? new AnthropicSummarizer({ apiKey: anthropicKey, model: anthropicModel })
      : null;
  // Router classifier + skill registry — process-singleton (no per-
  // meeting state). The classifier and registry are paired: both must
  // be present for the router branch in maybeRetrieveAndEmit to fire.
  // buildSkillRegistry gates the live GitHub skills on the platform
  // GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_BASE64)
  // and resolves each meeting org's installation token + repos from the
  // sources table at call time.
  const classifier: Classifier | null =
    anthropicKey !== undefined && anthropicKey.length > 0
      ? new AnthropicClassifier({ apiKey: anthropicKey, model: anthropicModel })
      : null;
  const skillRegistry: SkillRegistry = buildSkillRegistry({
    db,
    logger: {
      info: (obj: object, msg?: string) => {
        console.log('[bot-worker]', msg ?? '', JSON.stringify(obj));
      },
      warn: (obj: object, msg?: string) => {
        console.warn('[bot-worker]', msg ?? '', JSON.stringify(obj));
      },
    },
  });
  if (synthesizer === null) {
    console.warn(
      '[bot-worker] ANTHROPIC_API_KEY unset — synthesis + LLM relevance + rolling summary + router classifier disabled',
    );
  }
  console.log(`[bot-worker] skill registry size: ${String(skillRegistry.size())}`);

  // Server options (incl. disableRequestLogging so the auth JWT in the URL path
  // is never logged, and maxParamLength for the long :jwt param). See
  // server-options.ts for the security rationale.
  const fastify = Fastify(fastifyServerOptions());
  await fastify.register(websocket);

  fastify.get('/health', () => ({ ok: true, runtimes: runtimes.size }));

  // POST /meetings/:id/end — called by the portal's status webhook
  // (U10) on bot.call_ended. Flushes in-memory state and removes the
  // runtime entry. The portal also updates meetings.status = 'completed'
  // before sending this.
  fastify.post<{ Params: { id: string } }>('/meetings/:id/end', async (req, reply) => {
    // U12 (S13): require the shared BOT_WORKER_SECRET — this mutates in-memory
    // state and is reachable over the public dev tunnel; it must not be anonymous.
    if (!bearerMatches(req.headers.authorization, secret)) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
    const meetingId = req.params.id;
    const runtime = runtimes.get(meetingId);
    if (runtime === undefined) return reply.send({ ok: true, removed: false });
    if (runtime.summarizer !== null) runtime.summarizer.dispose();
    runtimes.delete(meetingId);
    return reply.send({ ok: true, removed: true });
  });

  // ── Local-audio meeting capture (dev only) ──────────────────────────────
  // POST /local-capture/start|stop + GET /status — gated on LOCAL_DEBUG_ENABLED
  // (so production never exposes it) AND the shared BOT_WORKER_SECRET. The dev
  // console drives a real meeting from the local mic sidecar through the SAME
  // pipeline a Recall meeting uses; one capture at a time (one mic, KTD5).
  const captureLogger = {
    info: (obj: object, msg?: string) => console.log('[bot-worker]', msg ?? '', JSON.stringify(obj)),
    warn: (obj: object, msg?: string) => console.warn('[bot-worker]', msg ?? '', JSON.stringify(obj)),
    error: (obj: object, msg?: string) => console.error('[bot-worker]', msg ?? '', JSON.stringify(obj)),
  };
  const localCaptureDeps = (deepgramKey: string): LocalCaptureDeps => ({
    db,
    embedder,
    synthesizer,
    relevanceClassifier,
    classifier,
    skillRegistry,
    summarizer,
    deepgramKey,
    logger: captureLogger,
  });
  const captureGuardFail = (authHeader: string | undefined): { code: number; body: object } | null => {
    if (process.env.LOCAL_DEBUG_ENABLED !== 'true') return { code: 404, body: { ok: false, error: 'not found' } };
    if (!bearerMatches(authHeader, secret)) return { code: 401, body: { ok: false, error: 'unauthorized' } };
    return null;
  };

  fastify.post<{ Body: { meetingId?: string; orgId?: string } }>('/local-capture/start', async (req, reply) => {
    const fail = captureGuardFail(req.headers.authorization);
    if (fail !== null) return reply.code(fail.code).send(fail.body);
    const { meetingId, orgId } = req.body ?? {};
    if (typeof meetingId !== 'string' || typeof orgId !== 'string') {
      return reply.code(400).send({ ok: false, error: 'meetingId + orgId required' });
    }
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramKey === undefined || deepgramKey.length === 0) {
      return reply.code(400).send({ ok: false, error: 'DEEPGRAM_API_KEY unset' });
    }
    try {
      await startLocalCapture(meetingId, orgId, localCaptureDeps(deepgramKey));
      return reply.send({ ok: true, meetingId });
    } catch (err) {
      if (err instanceof LocalCaptureBusyError) {
        return reply.code(409).send({ ok: false, error: 'busy', activeMeetingId: err.activeMeetingId });
      }
      return reply.code(500).send({ ok: false, error: (err as Error).message });
    }
  });

  fastify.post<{ Body: { meetingId?: string } }>('/local-capture/stop', async (req, reply) => {
    const fail = captureGuardFail(req.headers.authorization);
    if (fail !== null) return reply.code(fail.code).send(fail.body);
    const meetingId = req.body?.meetingId;
    if (typeof meetingId !== 'string') {
      return reply.code(400).send({ ok: false, error: 'meetingId required' });
    }
    const stopped = await stopLocalCapture(meetingId, captureLogger);
    return reply.send({ ok: true, stopped });
  });

  fastify.get('/local-capture/status', async (req, reply) => {
    const fail = captureGuardFail(req.headers.authorization);
    if (fail !== null) return reply.code(fail.code).send(fail.body);
    return reply.send({ ok: true, activeMeetingId: activeLocalCapture() });
  });

  // @fastify/websocket v11 requires the WS route to be registered inside
  // a child instance returned by fastify.register(...) — the websocket
  // plugin's decorators only flow to routes registered through that path.
  // Using fastify.route() with both `handler` and `wsHandler` so plain
  // HTTP probes get a 200 (some clients do an HTTP GET to check the
  // endpoint before upgrading).
  // Use a wildcard for the JWT segment — Fastify's `:param` matcher
  // doesn't reliably match strings with dots (JWTs have two), so we
  // catch the rest of the path with `*` and pull the JWT off ourselves.
  await fastify.register((instance) => {
    instance.route<{ Params: { meetingId: string; '*': string } }>({
      method: 'GET',
      url: '/recall/:meetingId/*',
      handler: (_req, reply) => {
        reply.code(200).send({ ok: true, kind: 'ws-endpoint' });
      },
      wsHandler: async (socket, req) => {
        const params = req.params;
        const meetingId = params.meetingId;
        const jwt = params['*'];
        let payload: BotWsJwtPayload;
        try {
          payload = await verifyBotWsJwt(jwt, secret);
        } catch (err) {
          req.log.warn({ err, meetingId }, 'jwt verify failed; closing ws');
          socket.send(JSON.stringify({ error: 'jwt-invalid' }));
          socket.close();
          return;
        }

        if (payload.meetingId !== meetingId) {
          req.log.warn(
            { jwtMeetingId: payload.meetingId, pathMeetingId: meetingId },
            'jwt meeting_id mismatch; closing ws (cross-meeting replay attempt)',
          );
          socket.close();
          return;
        }

        // Reuse a runtime if Recall reconnected; otherwise spin one up.
        let runtime = runtimes.get(meetingId);
        if (runtime === undefined) {
          const logger = req.log;
          runtime = {
            meetingId,
            orgId: payload.orgId,
            connectedAt: Date.now(),
            utteranceCount: 0,
            markedRecording: false,
            retrieval: newRetrievalRuntime(),
            segments: newSegmentTracker(),
            summarizer:
              summarizer !== null
                ? new MeetingSummarizerRuntime({
                    summarizer,
                    onSummaryUpdated: (s, at) => {
                      logger.info(
                        {
                          meetingId,
                          currentTopic: s.current_topic,
                          openQuestions: s.open_questions.length,
                          keyTerms: s.key_terms.length,
                          at,
                        },
                        'summary.updated',
                      );
                    },
                    onSummarizerError: (err) => {
                      logger.warn({ meetingId, err: String(err) }, 'summarizer.error');
                    },
                  })
                : null,
          };
          runtimes.set(meetingId, runtime);
          req.log.info(
            { meetingId, orgId: payload.orgId, summarizer: runtime.summarizer !== null },
            'runtime.created',
          );
        } else {
          req.log.info({ meetingId }, 'runtime.reconnected');
        }

        socket.on('message', (raw: Buffer) => {
          void handleMessage(
            raw,
            meetingId,
            payload.orgId,
            db,
            embedder,
            synthesizer,
            relevanceClassifier,
            classifier,
            skillRegistry,
            req.log,
          );
        });

        socket.on('close', () => {
          req.log.info({ meetingId }, 'ws.closed');
          // Don't delete the runtime — Recall may reconnect. Lifecycle
          // is owned by the POST /meetings/:id/end handler.
        });

        socket.on('error', (err) => {
          req.log.error({ err, meetingId }, 'ws.error');
        });
      },
    });

    // Debug-only local-mic pipeline (sidecar → Deepgram → retrieval →
    // synthesis → stream events back over the WS). Auth: short-lived
    // JWT minted by the portal server-side, same secret as Recall WS.
    // Linux-only (sidecar binary path is Linux PulseAudio). Gate on
    // LOCAL_DEBUG_ENABLED=true so production deployments don't expose
    // this surface accidentally.
    const localDebugEnabled = process.env.LOCAL_DEBUG_ENABLED === 'true';
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    instance.route<{ Params: { '*': string } }>({
      method: 'GET',
      url: '/local-debug/*',
      handler: (_req, reply) => {
        reply.code(200).send({ ok: true, kind: 'local-debug-ws', enabled: localDebugEnabled });
      },
      wsHandler: async (socket, req) => {
        if (!localDebugEnabled) {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: 'local-debug disabled (set LOCAL_DEBUG_ENABLED=true)',
            }),
          );
          socket.close();
          return;
        }
        if (deepgramKey === undefined || deepgramKey.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: 'DEEPGRAM_API_KEY unset' }));
          socket.close();
          return;
        }
        if (voyageKey === undefined || voyageKey.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: 'VOYAGE_API_KEY unset' }));
          socket.close();
          return;
        }
        if (anthropicKey === undefined || anthropicKey.length === 0) {
          socket.send(JSON.stringify({ type: 'error', message: 'ANTHROPIC_API_KEY unset' }));
          socket.close();
          return;
        }
        const jwt = req.params['*'];
        let payload: BotWsJwtPayload;
        try {
          payload = await verifyBotWsJwt(jwt, secret);
        } catch (err) {
          req.log.warn({ err }, 'local-debug.jwt.invalid');
          socket.send(JSON.stringify({ type: 'error', message: 'jwt-invalid' }));
          socket.close();
          return;
        }
        await handleLocalDebugWs(socket, {
          db,
          orgId: payload.orgId,
          anthropicKey,
          anthropicModel,
          voyageKey,
          deepgramKey,
          logger: req.log,
        });
      },
    });

    // Eval dev-page endpoints (portal /debug/eval). Same LOCAL_DEBUG_ENABLED
    // gate + BOT_WORKER_SECRET JWT auth as the WS above.
    registerEvalRoutes(instance, { db, secret, voyageKey, anthropicKey });
  });

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`bot-worker listening on :${port}`);
  } catch (err) {
    fastify.log.error(err, 'failed to start');
    process.exit(1);
  }
}

/**
 * Per-message pipeline: parse → adapt → (first-time-only) mark
 * meetings.status='recording' → write meeting_events + broadcast.
 *
 * We swallow + log per-message errors so one bad payload can't take
 * down the WS for the whole meeting. The DB / broadcast helpers are
 * already defensive about partial failure (DB-first per R23a).
 */
async function handleMessage(
  raw: Buffer,
  meetingId: string,
  orgId: string,
  db: SupabaseClient,
  embedder: VoyageEmbedder | null,
  synthesizer: Synthesizer | null,
  relevanceClassifier: RelevanceClassifier | null,
  classifier: Classifier | null,
  skillRegistry: SkillRegistry,
  logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
  },
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    logger.warn({ meetingId }, 'recall.message non-json; dropping');
    return;
  }

  const adapted = adaptRecallMessage(parsed);
  if (adapted.kind !== 'utterance') {
    // ignored event (participant_events.*, unknown). Could write
    // participant joins/leaves to meeting_events later for the live
    // page's speaker bar — skipping for V1.
    return;
  }

  const runtime = runtimes.get(meetingId);
  if (runtime !== undefined) runtime.utteranceCount += 1;

  // First-utterance status flip. Best-effort — if the DB call fails
  // we still write the event below, and the live page falls back to
  // its initial DB fetch on next reload.
  if (runtime !== undefined && !runtime.markedRecording) {
    const flipped = await markRecordingIfFirst(db, { meetingId, orgId });
    if (flipped) {
      runtime.markedRecording = true;
      logger.info({ meetingId }, 'meetings.status → recording');
    } else {
      // Either the meeting was already past 'recording' (reconnect
      // case) or the row vanished. Either way, no point retrying
      // this side of the lifecycle.
      runtime.markedRecording = true;
    }
  }

  // Transcript broadcast. Branch on finality:
  //   - PARTIAL (interim): transient broadcast for the live transcript UI —
  //     `transcript.partial_data`, NEVER persisted, throttled, carrying a STABLE
  //     per-speech utteranceId so the client can morph the interim into its
  //     final. See segment-tracker.ts for the full pass-2 wire contract.
  //   - FINAL: the clean, durable running transcript — persisted (encrypted at
  //     rest) + broadcast as `transcript.data`. We override its id with the open
  //     segment's stable id so the final REPLACES the interim line on the client
  //     rather than appending a duplicate.
  //
  // `resolvedUtterance` is the final utterance (id resolved) threaded through to
  // BOTH the persist+broadcast and the downstream retrieval/synthesis so they
  // anchor on the same id. It's only set on the final branch.
  let resolvedUtterance = adapted.utterance;
  if (!adapted.utterance.isFinal) {
    // Partials are display-only: broadcast even in transcript-only / no-Voyage
    // mode (no embedder/summarizer dependency). When no runtime exists (e.g. a
    // stray message before registration) there's no segment store, so skip.
    if (runtime !== undefined) {
      const now = Date.now();
      const { utteranceId, revision, shouldBroadcast } = resolvePartial(
        runtime.segments,
        adapted.utterance.utteranceId,
        now,
      );
      if (shouldBroadcast) {
        const { broadcasted } = await broadcastOnly(db, {
          meetingId,
          orgId,
          type: 'transcript.partial_data',
          // Same payload shape as transcript.data, with the stable id + the
          // monotonic segment revision + isFinal:false. NOT persisted.
          payload: utteranceToEventPayload({
            ...adapted.utterance,
            utteranceId,
            revision,
            isFinal: false,
          }),
        });
        logger.info(
          {
            meetingId,
            broadcasted,
            revision,
            speaker: adapted.utterance.speaker,
            // Transcript body redacted by default (U6); verbatim only under LOG_TRANSCRIPTS=1.
            ...transcriptLogFields(adapted.utterance.text),
          },
          'utterance.partial',
        );
      }
    }
  } else {
    // Resolve the final's id against any open segment so it lands on the same id
    // the partials used (and clear the segment).
    const { utteranceId, revision } =
      runtime !== undefined
        ? resolveFinal(runtime.segments, adapted.utterance.utteranceId)
        : { utteranceId: adapted.utterance.utteranceId, revision: adapted.utterance.revision };
    resolvedUtterance = { ...adapted.utterance, utteranceId, revision };

    const result = await persistAndBroadcast(db, {
      meetingId,
      orgId,
      type: 'transcript.data',
      payload: utteranceToEventPayload(resolvedUtterance),
    });
    logger.info(
      {
        meetingId,
        eventId: result.eventId,
        broadcasted: result.broadcasted,
        speaker: resolvedUtterance.speaker,
        // Transcript body redacted by default (U6); verbatim only under LOG_TRANSCRIPTS=1.
        ...transcriptLogFields(resolvedUtterance.text),
      },
      'utterance',
    );
  }

  // Retrieval only fires on FINAL utterances (we don't want partials
  // moving the rolling window each time a word changes). Also
  // requires the embedder to be configured.
  if (adapted.utterance.isFinal && embedder !== null && runtime !== undefined) {
    // Feed the summarizer runtime BEFORE retrieval so the current
    // utterance is part of the next summary's transcript window.
    // The summary used FOR this retrieval is the prior one (already
    // in lastSummary) — that's correct: we want the long-range context
    // that existed when this utterance was spoken, not a future summary.
    if (runtime.summarizer !== null) {
      runtime.summarizer.recordUtterance(adapted.utterance.text);
    }
    // Read lastSummary ONCE here, atomically, before the async pipeline
    // begins — same invariant as the debug path's torn-read guard.
    const lastSummary = runtime.summarizer !== null ? runtime.summarizer.getLastSummary() : null;
    const retrievalResult = await maybeRetrieveAndEmit({
      runtime: runtime.retrieval,
      utteranceText: resolvedUtterance.text,
      utteranceId: resolvedUtterance.utteranceId,
      meetingId,
      orgId,
      db,
      embedder,
      ...(synthesizer !== null ? { synthesizer } : {}),
      ...(relevanceClassifier !== null ? { relevanceClassifier } : {}),
      ...(classifier !== null ? { classifier } : {}),
      skillRegistry,
      ...(lastSummary !== null ? { lastSummary } : {}),
      // Close the loop: feed a grounded answer back to the summarizer so the
      // open question it resolved retires from the next rolling summary.
      ...(runtime.summarizer !== null
        ? { onGroundedAnswer: (text: string) => runtime.summarizer!.recordAssistantAnswer(text) }
        : {}),
      // Demand-driven rolling summary: a question is being answered → refresh
      // the summary if it's stale (no-op otherwise; never in a question-less
      // meeting).
      ...(runtime.summarizer !== null
        ? { onSynthesisRequested: () => runtime.summarizer!.refreshIfStale() }
        : {}),
      // Knowledge-gap capture (U3): a question the copilot attempted but
      // couldn't ground is recorded as a raw miss for post-meeting assembly.
      onMiss: (miss) => {
        void recordMiss(db, miss, logger);
      },
      logger,
    });
    if (retrievalResult.emitted > 0 || retrievalResult.skipped !== undefined) {
      logger.info(
        { meetingId, emitted: retrievalResult.emitted, skipped: retrievalResult.skipped },
        'retrieval.tick',
      );
    }
  }
}

function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid BOT_WORKER_PORT: ${raw}`);
  }
  return n;
}

main().catch((err) => {
  console.error('[bot-worker] fatal:', err);
  process.exit(1);
});
