import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  readonly version: string;
}

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', () => ({ ok: true, version: options.version }));
}
