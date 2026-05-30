import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import { buildCspHeader } from '../server/csp.js';
import { loadHudInlineScriptHashes } from '../server/hud-inline-hashes.js';
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
import type {
  CardEvent,
  CardRetracted,
  CardUpdated,
  SynthesisDelta,
  SynthesisDone,
  SynthesisError,
  SynthesisRetracted,
  SynthesisStart,
} from '../retrieve/contract.js';
import { AnthropicSynthesizer, DEFAULT_ANTHROPIC_MODEL } from '../synthesize/anthropic.js';
import { AnthropicClassifier } from '../router/anthropic-classifier.js';
import { AnthropicRelevanceClassifier } from '../relevance/anthropic-classifier.js';
import { SkillRegistry } from '../skills/registry.js';
import { skills as githubSkills } from '../skills/github/index.js';
import { hasConsent } from './consent-store.js';
import { envFloat, envInt, log, optionalEnv, requireEnv } from './util.js';

// Next.js static export from apps/hud-next. The U5 cutover moved this from
// the legacy esbuild bundle (apps/hud/dist) to the Next.js export. The
// daemon now serves the chunked `_next/static/*` tree directly; the entry
// HTML still passes through the bootstrap-injection logic at `/`.
const HUD_DIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'hud-next',
  'out',
);

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
  synthesisStart: [SynthesisStart];
  synthesisDelta: [SynthesisDelta];
  synthesisDone: [SynthesisDone];
  synthesisError: [SynthesisError];
  synthesisRetracted: [SynthesisRetracted];
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
  // These MUST mirror what `pnpm daemon index` used or the query embedding
  // lands in a different semantic space than the corpus — search becomes
  // noise. The query and corpus models share an .env source of truth.
  const voyageTextModel = optionalEnv('VOYAGE_TEXT_MODEL');
  const voyageCodeModel = optionalEnv('VOYAGE_CODE_MODEL');

  // Synthesis is opt-in. Absent ANTHROPIC_API_KEY → no synthesizer wired,
  // pipeline behaves exactly as before (raw cards only). The consent gate
  // is checked per-flush via the hasConsent helper against the existing
  // consent SQLite table.
  const anthropicKey = optionalEnv('ANTHROPIC_API_KEY');
  const anthropicModel = optionalEnv('ANTHROPIC_MODEL') ?? DEFAULT_ANTHROPIC_MODEL;
  const synthesisMinScore = envFloat('UPWELL_SYNTHESIS_MIN_SCORE', 0.025);
  const synthesisTopN = envInt('UPWELL_SYNTHESIS_TOP_N', 3);
  const synthesisMaxTokens = envInt('UPWELL_SYNTHESIS_MAX_TOKENS', 150);
  const relevanceSkipThreshold = envFloat('UPWELL_RELEVANCE_SKIP_THRESHOLD', 0.7);
  const relevanceTimeoutMs = envInt('UPWELL_RELEVANCE_TIMEOUT_MS', 3000);

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
      `HUD bundle not found at ${HUD_DIST}. Run 'pnpm --filter @upwell/hud-next build' first.`,
    );
  }

  // Compute SHA-256 hashes of every inline <script> body in the static
  // export. Next.js ships several inline scripts (theme init + hydration
  // payload); strict CSP requires either 'unsafe-inline' or the hash of
  // each script body. We choose hashes — strictest policy that still
  // allows the page to hydrate. Hashes are computed once at startup;
  // they only change when the HUD build changes, which requires a daemon
  // restart anyway.
  const hudInlineScriptHashes = await loadHudInlineScriptHashes(HUD_DIST);
  if (hudInlineScriptHashes.length === 0 && hudBootstrapHtml !== null) {
    log(
      'warn',
      `HUD has no inline-script hashes — strict CSP may block hydration. Build at ${HUD_DIST} may be malformed.`,
    );
  } else {
    log('info', `HUD inline-script hashes: ${String(hudInlineScriptHashes.length)} computed`);
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
      onRetryWait: (info) =>
        log(
          'warn',
          `voyage.retry attempt=${String(info.attempt)}/${String(info.maxRetries)} wait=${String(info.waitMs)}ms reason=${info.reason}`,
        ),
      ...(voyageTextModel !== undefined && { textModel: voyageTextModel }),
      ...(voyageCodeModel !== undefined && { codeModel: voyageCodeModel }),
    });
    const synthesizer =
      anthropicKey !== undefined
        ? new AnthropicSynthesizer({
            apiKey: anthropicKey,
            model: anthropicModel,
            maxTokens: synthesisMaxTokens,
            onUsage: (u) => log('info', 'synthesis.usage', { ...u }),
          })
        : undefined;
    if (synthesizer === undefined) {
      log('info', 'synthesis.disabled reason=no-key (set ANTHROPIC_API_KEY to enable)');
    }

    // Router: classifier + skill registry. Instantiated on key-only (NOT
    // on consent — consent is checked at usage time inside the pipeline so
    // revocation takes effect on the next flush without a daemon restart).
    // Same ANTHROPIC_API_KEY enables both synthesizer and classifier; no
    // separate key or consent grant needed.
    const skillRegistry = new SkillRegistry();
    for (const s of githubSkills) skillRegistry.register(s);
    const classifier =
      anthropicKey !== undefined
        ? new AnthropicClassifier({
            apiKey: anthropicKey,
            model: anthropicModel,
            onUsage: (u) => log('info', 'classifier.usage', { ...u }),
          })
        : undefined;
    if (classifier === undefined) {
      log('info', 'router.disabled reason=no-key (set ANTHROPIC_API_KEY to enable)');
    } else {
      log('info', `router.enabled skills=${String(skillRegistry.size())}`);
    }

    // Relevance pre-classifier. Same key-only instantiation pattern as the
    // router — consent is checked per-flush inside the pipeline so
    // revocation takes effect without a daemon restart.
    const relevanceClassifier =
      anthropicKey !== undefined
        ? new AnthropicRelevanceClassifier({
            apiKey: anthropicKey,
            model: anthropicModel,
            onUsage: (u) => log('info', 'relevance.usage', { ...u }),
          })
        : undefined;
    if (relevanceClassifier === undefined) {
      log('info', 'relevance.disabled reason=no-key (heuristic-only mode; ambiguous utterances default to surface)');
    } else {
      log('info', `relevance.enabled threshold=${String(relevanceSkipThreshold)} timeoutMs=${String(relevanceTimeoutMs)}`);
    }

    const consentClosure = (): boolean => hasConsent(db, 'anthropic');

    const pipeline = new RetrievalPipeline({
      db,
      embedder,
      session,
      debounceMs: 700,
      minScore: 0,
      ...(synthesizer !== undefined && { synthesizer }),
      // The same consent closure gates synthesis, the router classifier,
      // and the relevance classifier — one revocation, three behaviors
      // silently downgrade (each emits its own per-flush log line so
      // operators can spot it).
      ...((synthesizer !== undefined || classifier !== undefined || relevanceClassifier !== undefined) && { consentCheck: consentClosure }),
      minSynthesisScore: synthesisMinScore,
      synthesisTopN,
      synthesisMaxTokens,
      ...(classifier !== undefined && { classifier }),
      skillRegistry,
      ...(relevanceClassifier !== undefined && { relevanceClassifier }),
      relevanceSkipThreshold,
      relevanceTimeoutMs,
    });
    pipeline.attachWindow(window);

    let frameCount = 0;
    runner.on('frame', (frame) => {
      engine.sendFrame(frame.samples);
      frameCount += 1;
      if (frameCount % 250 === 0) {
        log('info', `audio.frames ${String(frameCount)} (~${String(Math.round(frameCount / 50))}s of audio)`);
      }
    });
    runner.on('control', (msg) => log('info', `sidecar.control ${JSON.stringify(msg)}`));
    runner.on('error', (err) => log('error', `sidecar: ${err.message}`));
    engine.on('partial', (p) => window.push(p.utterance));
    engine.on('final', (f) => {
      window.push(f.utterance);
      logUtterance(f.utterance);
    });
    engine.on('error', (err) => log('error', `transcribe: ${err.message}`));
    pipeline.on('card', (card) => cardBus.emit('card', card));
    pipeline.on('error', (err) => log('error', `retrieve: ${err.message}`));
    // Bridge synthesis events from the pipeline onto the cardBus so the
    // broadcast loop fans them out over the WebSocket.
    pipeline.on('synthesisStart', (e) => {
      log('info', `synthesis.start ${e.synthesisId} sources=${String(e.sourceCardIds.length)}`);
      cardBus.emit('synthesisStart', e);
    });
    pipeline.on('synthesisDelta', (e) => cardBus.emit('synthesisDelta', e));
    pipeline.on('synthesisDone', (e) => {
      log('info', 'synthesis.done', {
        synthesisId: e.synthesisId,
        citations: e.citations,
        ttftMs: e.ttftMs,
        latencyMs: e.latencyMs,
        inputTokens: e.usage.inputTokens,
        outputTokens: e.usage.outputTokens,
        cacheReadTokens: e.usage.cacheReadTokens,
        cacheCreationTokens: e.usage.cacheCreationTokens,
      });
      cardBus.emit('synthesisDone', e);
    });
    pipeline.on('synthesisError', (e) => {
      // Aborts are normal lifecycle (a newer flush superseded the prior
      // synthesis). Log at info, not warn. Other codes stay at warn.
      const level = e.code === 'aborted' ? 'info' : 'warn';
      log(
        level,
        `synthesis.error ${e.synthesisId} code=${e.code}`,
        e.message !== undefined ? { message: e.message } : undefined,
      );
      cardBus.emit('synthesisError', e);
    });
    pipeline.on('synthesisRetracted', (e) => {
      log('info', `synthesis.retracted ${e.synthesisId} reason=${e.reason}`);
      cardBus.emit('synthesisRetracted', e);
    });

    // Router telemetry — log only; no HUD broadcast for v1. The synthesizer
    // already surfaces the tool result inside the synthesis card, so the
    // user-visible signal doesn't need a separate event family.
    pipeline.on('classifierStart', (e) => log('info', 'classifier.start', { ...e }));
    pipeline.on('classifierDone', (e) =>
      log('info', 'classifier.done', {
        traceId: e.traceId,
        intent: e.intent,
        skillName: e.skillName,
        latencyMs: e.latencyMs,
        ...(e.usage !== undefined && {
          inputTokens: e.usage.inputTokens,
          outputTokens: e.usage.outputTokens,
          cacheReadTokens: e.usage.cacheReadTokens,
          cacheCreationTokens: e.usage.cacheCreationTokens,
        }),
      }),
    );
    pipeline.on('classifierSkipped', (e) =>
      log('info', 'classifier.skipped', { ...e }),
    );
    pipeline.on('classifierError', (e) =>
      log('warn', 'classifier.error', { ...e }),
    );
    pipeline.on('skillStart', (e) =>
      log('info', 'skill.start', { traceId: e.traceId, name: e.name, args: e.args }),
    );
    pipeline.on('skillDone', (e) =>
      log('info', 'skill.done', {
        traceId: e.traceId,
        name: e.name,
        latencyMs: e.latencyMs,
        resultShape: e.resultShape,
      }),
    );
    pipeline.on('skillFailed', (e) =>
      log('warn', 'skill.failed', {
        traceId: e.traceId,
        name: e.name,
        code: e.code,
        message: e.message,
      }),
    );

    // Relevance telemetry — log only. relevance.classified fires on every
    // LLM call regardless of decision, giving a greppable distribution of
    // confidence values that makes the UPWELL_RELEVANCE_SKIP_THRESHOLD env
    // var tunable from real meeting data. relevance.skipped fires only on
    // actual skip decisions (heuristic short-circuit, LLM above threshold,
    // or cached prior skip).
    pipeline.on('relevanceSkip', (e) =>
      log('info', 'relevance.skipped', {
        traceId: e.traceId,
        utterance: e.utterance,
        gate: e.gate,
        reason: e.reason,
        ...(e.confidence !== undefined && { confidence: e.confidence }),
      }),
    );
    pipeline.on('relevanceLlmStart', (e) =>
      log('info', 'relevance.start', {
        traceId: e.traceId,
        utterance: e.utterance,
      }),
    );
    pipeline.on('relevanceClassified', (e) =>
      log('info', 'relevance.classified', {
        traceId: e.traceId,
        utterance: e.utterance,
        decision: e.decision,
        confidence: e.confidence,
        latencyMs: e.latencyMs,
      }),
    );
    pipeline.on('relevanceLlmError', (e) =>
      log('warn', 'relevance.error', {
        traceId: e.traceId,
        code: e.code,
        message: e.message,
      }),
    );

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
        hudInlineScriptHashes,
      );
      app.get('/ws/events', { websocket: true }, (socket) => {
        socket.send(JSON.stringify({ type: 'hello', version: '0.0.0-dev' }));
        // State replay: a HUD that connected AFTER a meeting started missed
        // the meetingStarted broadcast (it was fanned out to zero
        // subscribers). Resync now so the LIVE indicator reflects reality
        // without requiring a meeting-end/restart cycle.
        if (meetingState.active !== null) {
          socket.send(
            JSON.stringify({
              type: 'meetingStarted',
              meetingId: meetingState.active.meetingId,
            }),
          );
        }
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
  cardBus.on('synthesisStart', (e) => broadcast({ type: 'synthesisStart', ...e }));
  cardBus.on('synthesisDelta', (e) => broadcast({ type: 'synthesisDelta', ...e }));
  cardBus.on('synthesisDone', (e) => broadcast({ type: 'synthesisDone', ...e }));
  cardBus.on('synthesisError', (e) => broadcast({ type: 'synthesisError', ...e }));
  cardBus.on('synthesisRetracted', (e) => broadcast({ type: 'synthesisRetracted', ...e }));

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
  inlineScriptHashes: readonly string[],
): void {
  app.get('/', (_req, reply) => {
    const bootstrapHtml = getHtml();
    if (bootstrapHtml === null) {
      void reply
        .type('text/plain')
        .send('HUD not built. Run `pnpm --filter @upwell/hud-next build`.');
      return;
    }
    const port = getPort();
    const wsUrl = `ws://127.0.0.1:${String(port)}/ws/events`;
    // Per-request nonce authorizes the bootstrap-config inline script.
    // The Next.js hydration scripts are authorized via the hash allow-list
    // computed at startup. Both mechanisms coexist in script-src.
    const nonce = randomBytes(16).toString('base64');
    const inject = `<script nonce="${nonce}">window.UPWELL_BOOTSTRAP = { wsUrl: ${JSON.stringify(wsUrl)}, token: ${JSON.stringify(getToken())} };</script>\n`;
    const html = bootstrapHtml.replace('</head>', `${inject}</head>`);
    void reply.header('Content-Security-Policy', buildCspHeader(port, nonce, inlineScriptHashes));
    void reply.type('text/html').send(html);
  });

  // Next.js chunked assets. `@fastify/static` handles MIME, range
  // requests, and path-traversal protection — the assets live under
  // `_next/static/<hashed-id>/...` and are content-addressed, so we can
  // serve them with a long-lived Cache-Control safely.
  void app.register(fastifyStatic, {
    root: join(HUD_DIST, '_next'),
    prefix: '/_next/',
    decorateReply: false,
    cacheControl: true,
    maxAge: '1y',
    immutable: true,
  });
}
