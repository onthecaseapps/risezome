import type { FastifyInstance } from 'fastify';

export function registerOAuthCallbackRoute(app: FastifyInstance): void {
  app.get('/oauth/callback/:connectorId', (_request, reply) => {
    reply.code(501).send({
      code: 'oauth-not-implemented',
      userMessage: 'OAuth flows are reserved for a future release. v1 uses personal access tokens.',
    });
  });
}
