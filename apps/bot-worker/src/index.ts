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
import { adaptRecallMessage } from './recall-adapter.js';
import { verifyBotWsJwt, type BotWsJwtPayload } from './jwt.js';

interface PerMeetingRuntime {
  meetingId: string;
  orgId: string;
  botId: string;
  /** When the first WS connect arrived. */
  connectedAt: number;
  /** Total utterances seen across reconnects. */
  utteranceCount: number;
}

const runtimes = new Map<string, PerMeetingRuntime>();

async function main(): Promise<void> {
  const port = parsePort(process.env['BOT_WORKER_PORT'] ?? '8787');
  const secret = process.env['BOT_WORKER_SECRET'];
  if (secret === undefined || secret.length === 0) {
    console.error('[bot-worker] BOT_WORKER_SECRET is required');
    process.exit(1);
  }

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
    runtimes.delete(meetingId);
    return reply.send({ ok: true, removed: true });
  });

  fastify.register(async (instance) => {
    instance.get<{ Params: { meetingId: string; jwt: string } }>(
      '/recall/:meetingId/:jwt',
      { websocket: true },
      async (socket, req) => {
        const { meetingId, jwt } = req.params;
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
          runtime = {
            meetingId,
            orgId: payload.orgId,
            botId: payload.botId,
            connectedAt: Date.now(),
            utteranceCount: 0,
          };
          runtimes.set(meetingId, runtime);
          req.log.info({ meetingId, orgId: payload.orgId, botId: payload.botId }, 'runtime.created');
        } else {
          req.log.info({ meetingId }, 'runtime.reconnected');
        }

        socket.on('message', (raw: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            req.log.warn({ meetingId }, 'recall.message non-json; dropping');
            return;
          }

          const adapted = adaptRecallMessage(parsed);
          if (adapted.kind !== 'utterance') {
            // ignored event — silently drop for now; U9d may emit
            // participant_events.* to update bookkeeping.
            return;
          }
          // U9c: just log. U9d wires this into the engine pipeline.
          const r = runtimes.get(meetingId);
          if (r !== undefined) r.utteranceCount += 1;
          req.log.info(
            {
              meetingId,
              speaker: adapted.utterance.speaker,
              isFinal: adapted.utterance.isFinal,
              text: adapted.utterance.text.slice(0, 80),
              count: r?.utteranceCount,
            },
            'utterance',
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
    );
  });

  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`bot-worker listening on :${port}`);
  } catch (err) {
    fastify.log.error(err, 'failed to start');
    process.exit(1);
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
