import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { fastifyServerOptions } from '../src/server-options';

/**
 * Security regression for U5 / S3: the WS-auth / eval JWT travels in the URL
 * path, so Fastify's automatic request logging must be OFF — otherwise the token
 * is written verbatim into every request log line.
 */

describe('fastifyServerOptions (U5)', () => {
  it('disables automatic request logging', () => {
    expect(fastifyServerOptions().disableRequestLogging).toBe(true);
  });

  it('an injected request with a JWT in the path produces no log line containing the token', async () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb): void {
        captured.push(chunk.toString('utf8'));
        cb();
      },
    });
    // Real production options, but pipe the logger to a capture stream.
    const app = Fastify({ ...fastifyServerOptions(), logger: { level: 'info', stream } });
    app.get<{ Params: { meetingId: string; jwt: string } }>(
      '/recall/:meetingId/:jwt',
      async () => ({ ok: true }),
    );
    await app.ready();

    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJtZWV0aW5nSWQiOiJ4In0.' + 's'.repeat(40);
    const res = await app.inject({ method: 'GET', url: `/recall/m1/${JWT}` });
    expect(res.statusCode).toBe(200);

    const logs = captured.join('');
    expect(logs).not.toContain(JWT); // the token never reaches the logs
    await app.close();
  });
});
