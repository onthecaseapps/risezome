import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  type SessionAuth,
  isAllowedHost,
  isAllowedOrigin,
  loadOrCreateSessionAuth,
} from './auth.js';
import { buildCspHeader } from './csp.js';
import { registerHealthRoute } from './routes/health.js';
import {
  registerStatusRoute,
  type StatusReporter,
  makeIdleStatusReporter,
} from './routes/status.js';
import { registerOAuthCallbackRoute } from './routes/oauth-callback.js';
import { registerWsRoute } from './ws/index.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const REQUIRED_CONTENT_TYPE = 'application/json';

export interface DaemonServerOptions {
  readonly version: string;
  readonly host?: string;
  readonly port: number;
  readonly dataDirOverride?: string;
  readonly statusReporter?: StatusReporter;
  readonly setupRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export interface DaemonServer {
  readonly fastify: FastifyInstance;
  readonly sessionAuth: SessionAuth;
  readonly boundPort: number;
  readonly boundHost: string;
  close(): Promise<void>;
}

export async function buildDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const sessionAuth = await loadOrCreateSessionAuth(options.dataDirOverride);
  const app = fastify({ logger: false });

  await registerWsRoute(app, { version: options.version });

  const host = options.host ?? '127.0.0.1';
  let boundPort = options.port;

  app.addHook('onRequest', (request, reply, done) => {
    const expectedPort = boundPort;
    if (!isAllowedHost(request.headers.host, expectedPort)) {
      void reply.code(403).send({
        code: 'forbidden-host',
        userMessage: 'Host header does not match this daemon.',
      });
      return;
    }
    const url = request.url;
    if (url === '/health') {
      done();
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, expectedPort)) {
      void reply.code(403).send({
        code: 'forbidden-origin',
        userMessage: 'Origin header is not allowed.',
      });
      return;
    }
    if (MUTATING_METHODS.has(request.method)) {
      const contentType = request.headers['content-type'];
      if (!contentType?.startsWith(REQUIRED_CONTENT_TYPE)) {
        void reply.code(415).send({
          code: 'unsupported-media-type',
          userMessage: 'Mutating routes require application/json.',
        });
        return;
      }
      if (!sessionAuth.validateBearer(request.headers.authorization)) {
        void reply.code(401).send({
          code: 'unauthorized',
          userMessage: 'Missing or invalid bearer token.',
        });
        return;
      }
    }
    done();
  });

  app.addHook('preValidation', (request, _reply, done) => {
    if (request.url === '/ws') {
      if (!sessionAuth.validateBearer(request.headers.authorization)) {
        const err = new Error('Missing or invalid bearer token');
        (err as Error & { statusCode?: number }).statusCode = 401;
        done(err);
        return;
      }
    }
    done();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('Content-Security-Policy', buildCspHeader(boundPort));
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    done(null, payload);
  });

  app.setErrorHandler(
    (
      error: Error & { statusCode?: number },
      _request: FastifyRequest,
      reply: FastifyReply,
    ): void => {
      const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
      void reply.code(statusCode).send({
        code: statusCode === 401 ? 'unauthorized' : 'internal-error',
        userMessage:
          statusCode === 401
            ? 'Missing or invalid bearer token.'
            : 'The daemon encountered an internal error.',
      });
    },
  );

  registerHealthRoute(app, { version: options.version });
  registerStatusRoute(app, options.statusReporter ?? makeIdleStatusReporter());
  registerOAuthCallbackRoute(app);

  if (options.setupRoutes !== undefined) {
    await options.setupRoutes(app);
  }

  const boundAddress = await app.listen({ host, port: options.port });
  const portMatch = /:(\d+)$/.exec(boundAddress);
  boundPort = portMatch?.[1] !== undefined ? Number(portMatch[1]) : options.port;

  return {
    fastify: app,
    sessionAuth,
    boundPort,
    boundHost: host,
    async close() {
      await app.close();
    },
  };
}
