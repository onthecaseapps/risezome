import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { openCorpusDb } from '../corpus/db.js';
import { migrate } from '../corpus/migrate.js';
import type { FastifyInstance } from 'fastify';
import { buildDaemonServer } from '../server/index.js';
import type { DaemonMode } from '../server/routes/status.js';
import type { Utterance } from '../transcribe/contract.js';
import { SidecarRunner } from '../audio/ipc/sidecar-runner.js';
import { DeepgramTranscriptionEngine } from '../transcribe/deepgram.js';
import { TranscriptStore } from '../transcript/store.js';
import { TranscriptWindow } from '../transcript/window.js';
import { MeetingSession } from '../meeting/session.js';
import { VoyageEmbedder } from '../embed/voyage.js';
import { RetrievalPipeline } from '../retrieve/pipeline.js';
import type { CardEvent, CardRetracted, CardUpdated } from '../retrieve/contract.js';
import { envInt, log, optionalEnv, requireEnv } from './util.js';

const HUD_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hud', 'dist');

interface ActiveMeeting {
  readonly meetingId: string;
  readonly runner: SidecarRunner;
  readonly engine: DeepgramTranscriptionEngine;
  readonly window: TranscriptWindow;
  readonly session: MeetingSession;
  readonly pipeline: RetrievalPipeline;
}

interface CardBusEvents {
  card: [CardEvent];
  cardUpdated: [CardUpdated];
  cardRetracted: [CardRetracted];
  meetingStarted: [{ meetingId: string }];
  meetingEnded: [{ meetingId: string }];
}

export async function runServe(): Promise<number> {
  const port = envInt('UPWELL_PORT', 0);
  const sidecarPath = resolve(
    optionalEnv('UPWELL_SIDECAR_PATH') ??
      join(process.cwd(), 'sidecars', 'linux', 'build', 'upwell-sidecar-linux'),
  );
  const sidecarSha = optionalEnv('UPWELL_SIDECAR_SHA');
  const dgKey = requireEnv('DEEPGRAM_API_KEY');
  const voyageKey = requireEnv('VOYAGE_API_KEY');

  const db = await openCorpusDb();
  await migrate(db);

  const store = new TranscriptStore(db);
  const cardBus = new EventEmitter<CardBusEvents>();
  const meetingState: { active: ActiveMeeting | null; mode: DaemonMode } = {
    active: null,
    mode: 'idle',
  };

  let hudBootstrapHtml: string | null = null;
  try {
    hudBootstrapHtml = await readFile(join(HUD_DIST, 'index.html'), 'utf8');
  } catch {
    log(
      'warn',
      `HUD bundle not found at ${HUD_DIST}. Run 'pnpm --filter @upwell/hud build' first.`,
    );
  }

  const wsConnections = new Set<{ send: (data: string) => void }>();

  const startMeeting = async (): Promise<ActiveMeeting> => {
    const meetingId = `m_${randomBytes(6).toString('hex')}`;
    log('info', `meeting.start ${meetingId}`);
    store.ensureMeeting(meetingId, null, Date.now());

    if (sidecarSha === undefined) {
      throw new Error('UPWELL_SIDECAR_SHA must be set in dev mode (or use a vendored manifest).');
    }
    const runner = new SidecarRunner({
      sidecarPath,
      manifest: { [sidecarPath]: { sha256: sidecarSha } },
      args: ['--role=system'],
    });
    const engine = new DeepgramTranscriptionEngine({ apiKey: dgKey });
    const window = new TranscriptWindow({ meetingId, store });
    const session = new MeetingSession(meetingId);
    const embedder = new VoyageEmbedder({
      apiKey: voyageKey,
      onUsage: (u) => log('info', 'voyage.usage', { ...u }),
    });
    const pipeline = new RetrievalPipeline({ db, embedder, session, debounceMs: 700, minScore: 0 });
    pipeline.attachWindow(window);

    runner.on('frame', (frame) => engine.sendFrame(frame.samples));
    runner.on('error', (err) => log('error', `sidecar: ${err.message}`));
    engine.on('partial', (p) => window.push(p.utterance));
    engine.on('final', (f) => {
      window.push(f.utterance);
      logUtterance(f.utterance);
    });
    engine.on('error', (err) => log('error', `transcribe: ${err.message}`));
    pipeline.on('card', (card) => cardBus.emit('card', card));
    pipeline.on('error', (err) => log('error', `retrieve: ${err.message}`));

    await engine.start();
    await runner.start();
    cardBus.emit('meetingStarted', { meetingId });
    return { meetingId, runner, engine, window, session, pipeline };
  };

  const endMeeting = async (): Promise<void> => {
    if (meetingState.active === null) return;
    const active = meetingState.active;
    log('info', `meeting.end ${active.meetingId}`);
    active.pipeline.detach();
    await active.engine.stop().catch(() => undefined);
    await active.runner.stop().catch(() => undefined);
    store.endMeeting(active.meetingId, Date.now());
    cardBus.emit('meetingEnded', { meetingId: active.meetingId });
    meetingState.active = null;
    meetingState.mode = 'idle';
  };

  const server = await buildDaemonServer({
    version: '0.0.0-dev',
    port,
    statusReporter: {
      mode: () => meetingState.mode,
      components: () => ({
        transcription: meetingState.active !== null ? 'connected' : 'unknown',
        retrieval: 'ready',
        audio: meetingState.active !== null ? 'running' : 'idle',
      }),
    },
    setupRoutes: (app) => {
      wireMeetingRoutesOnApp(app, meetingState, startMeeting);
      wireMeetingEndRouteOnApp(app, endMeeting);
      wireHudRoutesOnApp(
        app,
        () => hudBootstrapHtml,
        () => server.boundPort,
        () => server.sessionAuth.token,
      );
      app.get('/ws/events', { websocket: true }, (socket) => {
        socket.send(JSON.stringify({ type: 'hello', version: '0.0.0-dev' }));
        const conn = { send: (data: string): void => socket.send(data) };
        wsConnections.add(conn);
        socket.on('close', () => wsConnections.delete(conn));
      });
    },
  });

  const broadcast = (msg: object): void => {
    const data = JSON.stringify(msg);
    for (const conn of wsConnections) {
      try {
        conn.send(data);
      } catch {
        wsConnections.delete(conn);
      }
    }
  };
  cardBus.on('card', (card) => broadcast({ type: 'card', card }));
  cardBus.on('cardUpdated', (update) => broadcast({ type: 'cardUpdated', update }));
  cardBus.on('cardRetracted', (retracted) => broadcast({ type: 'cardRetracted', retracted }));
  cardBus.on('meetingStarted', (e) => broadcast({ type: 'meetingStarted', ...e }));
  cardBus.on('meetingEnded', (e) => broadcast({ type: 'meetingEnded', ...e }));

  const url = `http://${server.boundHost}:${String(server.boundPort)}/`;
  log('info', `Upwell listening at ${url}`);
  log('info', `Bootstrap URL (open in browser): ${url}?token=${server.sessionAuth.token}`);

  // Keep the process alive until SIGINT/SIGTERM.
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      log('info', 'shutdown signal received');
      void server.close().then(() => {
        db.close();
        resolve();
      });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  return 0;
}

function logUtterance(u: Utterance): void {
  log('info', `final ${u.utteranceId}`, { text: u.text, speaker: u.speaker });
}

function wireMeetingRoutesOnApp(
  app: FastifyInstance,
  state: { active: ActiveMeeting | null; mode: DaemonMode },
  startMeeting: () => Promise<ActiveMeeting>,
): void {
  app.post('/meeting/start', async (_req, reply) => {
    if (state.active !== null) {
      void reply.code(409).send({
        code: 'meeting-already-active',
        userMessage: 'A meeting is already in progress. End it before starting a new one.',
      });
      return;
    }
    try {
      state.active = await startMeeting();
      state.mode = 'capturing';
      void reply.send({ meetingId: state.active.meetingId });
    } catch (err) {
      log('error', `meeting.start failed: ${(err as Error).message}`);
      state.active = null;
      state.mode = 'idle';
      void reply.code(500).send({
        code: 'meeting-start-failed',
        userMessage: 'Failed to start meeting; see daemon logs.',
      });
    }
  });
}

function wireMeetingEndRouteOnApp(app: FastifyInstance, endMeeting: () => Promise<void>): void {
  app.post('/meeting/end', async (_req, reply) => {
    await endMeeting();
    void reply.send({ ok: true });
  });
}

function wireHudRoutesOnApp(
  app: FastifyInstance,
  getHtml: () => string | null,
  getPort: () => number,
  getToken: () => string,
): void {
  app.get('/', (_req, reply) => {
    const bootstrapHtml = getHtml();
    if (bootstrapHtml === null) {
      void reply.type('text/plain').send('HUD not built. Run `pnpm --filter @upwell/hud build`.');
      return;
    }
    const port = getPort();
    const wsUrl = `ws://127.0.0.1:${String(port)}/ws/events`;
    const inject = `<script>window.UPWELL_BOOTSTRAP = { wsUrl: ${JSON.stringify(wsUrl)}, token: ${JSON.stringify(getToken())} };</script>\n`;
    const html = bootstrapHtml.replace('</head>', `${inject}</head>`);
    void reply.type('text/html').send(html);
  });

  app.get('/assets/main.js', async (_req, reply) => {
    try {
      const body = await readFile(join(HUD_DIST, 'main.js'));
      void reply.type('application/javascript').send(body);
    } catch {
      void reply.code(404).send({ code: 'asset-missing', userMessage: 'main.js not built' });
    }
  });

  app.get('/assets/styles.css', async (_req, reply) => {
    try {
      const body = await readFile(join(HUD_DIST, 'styles.css'));
      void reply.type('text/css').send(body);
    } catch {
      void reply.code(404).send({ code: 'asset-missing', userMessage: 'styles.css not built' });
    }
  });
}
