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
import websocket from '@fastify/websocket';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  AnthropicSynthesizer,
  DEFAULT_ANTHROPIC_MODEL,
  type Synthesizer,
} from '@risezome/engine/synthesize';
import {
  AnthropicRelevanceClassifier,
  type RelevanceClassifier,
} from '@risezome/engine/relevance';
import {
  AnthropicSummarizer,
  type Summarizer,
} from '@risezome/engine/summarize';
import {
  AnthropicClassifier,
  type Classifier,
} from '@risezome/engine/router';
import { SkillRegistry } from '@risezome/engine/skills';
import { buildSkillRegistry } from './skills/index.js';
import { adaptRecallMessage } from './recall-adapter.js';
import { verifyBotWsJwt, type BotWsJwtPayload } from './jwt.js';
import { handleLocalDebugWs } from './debug/local-debug-ws.js';
import {
  createServiceClient,
  markRecordingIfFirst,
  persistAndBroadcast,
  utteranceToEventPayload,
} from './db.js';
import {
  maybeRetrieveAndEmit,
  newRetrievalRuntime,
  type RetrievalRuntime,
} from './retrieval.js';
import { MeetingSummarizerRuntime } from './summarizer-runtime.js';
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
}

const runtimes = new Map<string, PerMeetingRuntime>();

async function main(): Promise<void> {
  const port = parsePort(process.env['BOT_WORKER_PORT'] ?? '8787');
  const secret = process.env['BOT_WORKER_SECRET'];
  if (secret === undefined || secret.length === 0) {
    console.error('[bot-worker] BOT_WORKER_SECRET is required');
    process.exit(1);
  }

  const db = createServiceClient();

  // Voyage embedder for per-utterance retrieval. Optional: if
  // VOYAGE_API_KEY isn't set, retrieval is silently disabled (the
  // transcript pipeline still runs). Lets you run the bot-worker in
  // "transcript-only" dev mode without standing up Voyage.
  const voyageKey = process.env['VOYAGE_API_KEY'];
  const embedder = voyageKey !== undefined && voyageKey.length > 0
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
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const anthropicModel = process.env['ANTHROPIC_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL;
  const synthesizer: Synthesizer | null = anthropicKey !== undefined && anthropicKey.length > 0
    ? new AnthropicSynthesizer({ apiKey: anthropicKey, model: anthropicModel })
    : null;
  const relevanceClassifier: RelevanceClassifier | null = anthropicKey !== undefined && anthropicKey.length > 0
    ? new AnthropicRelevanceClassifier({ apiKey: anthropicKey, model: anthropicModel })
    : null;
  const summarizer: Summarizer | null = anthropicKey !== undefined && anthropicKey.length > 0
    ? new AnthropicSummarizer({ apiKey: anthropicKey, model: anthropicModel })
    : null;
  // Router classifier + skill registry — process-singleton (no per-
  // meeting state). The classifier and registry are paired: both must
  // be present for the router branch in maybeRetrieveAndEmit to fire.
  // buildSkillRegistry reads env vars (GITHUB_TOKEN + UPWELL_GITHUB_REPO,
  // etc.) and registers whichever skills are configured.
  const classifier: Classifier | null = anthropicKey !== undefined && anthropicKey.length > 0
    ? new AnthropicClassifier({ apiKey: anthropicKey, model: anthropicModel })
    : null;
  const skillRegistry: SkillRegistry = buildSkillRegistry({
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
    console.warn('[bot-worker] ANTHROPIC_API_KEY unset — synthesis + LLM relevance + rolling summary + router classifier disabled');
  }
  console.log(`[bot-worker] skill registry size: ${String(skillRegistry.size())}`);

  const fastify = Fastify({ logger: { level: 'info' } });
  await fastify.register(websocket);

  fastify.get('/health', async () => ({ ok: true, runtimes: runtimes.size }));

  // POST /meetings/:id/end — called by the portal's status webhook
  // (U10) on bot.call_ended. Flushes in-memory state and removes the
  // runtime entry. The portal also updates meetings.status = 'completed'
  // before sending this.
  fastify.post<{ Params: { id: string } }>('/meetings/:id/end', async (req, reply) => {
    const meetingId = req.params.id;
    const runtime = runtimes.get(meetingId);
    if (runtime === undefined) return reply.send({ ok: true, removed: false });
    if (runtime.summarizer !== null) runtime.summarizer.dispose();
    runtimes.delete(meetingId);
    return reply.send({ ok: true, removed: true });
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
  await fastify.register(async (instance) => {
    instance.route<{ Params: { meetingId: string; '*': string } }>({
      method: 'GET',
      url: '/recall/:meetingId/*',
      handler: (_req, reply) => {
        reply.code(200).send({ ok: true, kind: 'ws-endpoint' });
      },
      wsHandler: async (socket, req) => {
        const params = req.params as { meetingId: string; '*': string };
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
            summarizer: summarizer !== null
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
          req.log.info({ meetingId, orgId: payload.orgId, summarizer: runtime.summarizer !== null }, 'runtime.created');
        } else {
          req.log.info({ meetingId }, 'runtime.reconnected');
        }

        socket.on('message', (raw: Buffer) => {
          void handleMessage(raw, meetingId, payload.orgId, db, embedder, synthesizer, relevanceClassifier, classifier, skillRegistry, req.log);
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
    const localDebugEnabled = process.env['LOCAL_DEBUG_ENABLED'] === 'true';
    const deepgramKey = process.env['DEEPGRAM_API_KEY'];
    instance.route<{ Params: { '*': string } }>({
      method: 'GET',
      url: '/local-debug/*',
      handler: (_req, reply) => {
        reply.code(200).send({ ok: true, kind: 'local-debug-ws', enabled: localDebugEnabled });
      },
      wsHandler: async (socket, req) => {
        if (!localDebugEnabled) {
          socket.send(JSON.stringify({ type: 'error', message: 'local-debug disabled (set LOCAL_DEBUG_ENABLED=true)' }));
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
        const jwt = (req.params as { '*': string })['*'];
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
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void },
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

  const eventType = adapted.utterance.isFinal ? 'transcript.data' : 'transcript.partial_data';
  const result = await persistAndBroadcast(db, {
    meetingId,
    orgId,
    type: eventType,
    payload: utteranceToEventPayload(adapted.utterance),
  });

  logger.info(
    {
      meetingId,
      type: eventType,
      eventId: result.eventId,
      broadcasted: result.broadcasted,
      speaker: adapted.utterance.speaker,
      text: adapted.utterance.text.slice(0, 60),
    },
    'utterance',
  );

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
      utteranceText: adapted.utterance.text,
      utteranceId: adapted.utterance.utteranceId,
      meetingId,
      orgId,
      db,
      embedder,
      ...(synthesizer !== null ? { synthesizer } : {}),
      ...(relevanceClassifier !== null ? { relevanceClassifier } : {}),
      ...(classifier !== null ? { classifier } : {}),
      skillRegistry,
      ...(lastSummary !== null ? { lastSummary } : {}),
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
