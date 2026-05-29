import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

export interface WsPluginOptions {
  readonly version: string;
}

export async function registerWsRoute(
  app: FastifyInstance,
  options: WsPluginOptions,
): Promise<void> {
  await app.register(fastifyWebsocket);
  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', version: options.version }));
  });
}
