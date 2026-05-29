import type { FastifyInstance } from 'fastify';

export type DaemonMode = 'idle' | 'capturing' | 'processing' | 'error';

export interface ComponentHealth {
  readonly transcription: 'unknown' | 'connected' | 'disconnected' | 'failed';
  readonly retrieval: 'unknown' | 'ready' | 'not-ready' | 'failed';
  readonly audio: 'unknown' | 'idle' | 'running' | 'failed';
}

export interface StatusReporter {
  mode(): DaemonMode;
  components(): ComponentHealth;
}

export function registerStatusRoute(app: FastifyInstance, reporter: StatusReporter): void {
  app.get('/status', () => ({
    mode: reporter.mode(),
    components: reporter.components(),
  }));
}

export function makeIdleStatusReporter(): StatusReporter {
  return {
    mode: () => 'idle',
    components: () => ({ transcription: 'unknown', retrieval: 'unknown', audio: 'unknown' }),
  };
}
