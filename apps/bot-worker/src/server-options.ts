import type { FastifyServerOptions } from 'fastify';

/**
 * Fastify options for the bot-worker HTTP/WS server.
 *
 * SECURITY (U5 / S3): `disableRequestLogging: true` is load-bearing. The
 * WS-auth and eval JWTs travel as URL path segments
 * (`/recall/:meetingId/:jwt`, `/local-debug-eval/:jwt/...`), and Fastify's
 * default request logging emits `req.url` verbatim at info level — which would
 * write a replayable bearer token into every log line (and, via the dev console,
 * into a browser stream + `.dev-logs/`). Disabling automatic request logging
 * suppresses that; the explicit `req.log.{info,warn}` calls in the route
 * handlers log structured fields (meetingId, orgId) and never the URL/token.
 *
 * `maxParamLength: 2000` — the JWT path param (~270 chars) exceeds Fastify's
 * default cap of 100, which would otherwise 404 the eval routes.
 */
export function fastifyServerOptions(): FastifyServerOptions {
  return {
    logger: { level: 'info' },
    disableRequestLogging: true,
    maxParamLength: 2000,
  };
}
