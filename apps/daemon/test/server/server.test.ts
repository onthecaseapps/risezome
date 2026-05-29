import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { buildDaemonServer, type DaemonServer } from '../../src/server/index.js';

interface RawHttpResult {
  status: number;
  body: string;
}

function rawHttpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

interface Harness {
  server: DaemonServer;
  dataDir: string;
  baseUrl: string;
}

async function startServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'upwell-server-'));
  const server = await buildDaemonServer({
    version: '0.0.0-test',
    port: 0,
    dataDirOverride: dataDir,
  });
  return {
    server,
    dataDir,
    baseUrl: `http://127.0.0.1:${String(server.boundPort)}`,
  };
}

async function stopServer(harness: Harness): Promise<void> {
  await harness.server.close();
  rmSync(harness.dataDir, { recursive: true, force: true });
}

function withLoopback(headers: Record<string, string>, port: number): Record<string, string> {
  return { Host: `127.0.0.1:${String(port)}`, ...headers };
}

describe('Daemon server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    await stopServer(h);
  });

  describe('GET routes', () => {
    it('GET /health returns 200 with ok and version', async () => {
      const res = await fetch(`${h.baseUrl}/health`, {
        headers: withLoopback({}, h.server.boundPort),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe('0.0.0-test');
    });

    it('GET /status returns daemon mode and component health', async () => {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: withLoopback({}, h.server.boundPort),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        components: { transcription: string; retrieval: string; audio: string };
      };
      expect(body.mode).toBe('idle');
      expect(body.components.audio).toBe('unknown');
    });

    it('GET /oauth/callback/:connectorId returns 501 with stable code', async () => {
      const res = await fetch(`${h.baseUrl}/oauth/callback/github?code=anything`, {
        headers: withLoopback({}, h.server.boundPort),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('oauth-not-implemented');
    });
  });

  describe('Host + Origin guards', () => {
    it('rejects requests with non-matching Host header', async () => {
      const res = await rawHttpGet(h.server.boundPort, '/status', {
        Host: 'evil.example.com',
      });
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as { code: string };
      expect(body.code).toBe('forbidden-host');
    });

    it('rejects requests with non-matching Origin header', async () => {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: withLoopback({ Origin: 'http://evil.example.com' }, h.server.boundPort),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('forbidden-origin');
    });

    it('accepts loopback Origin matching the bound port', async () => {
      const res = await fetch(`${h.baseUrl}/status`, {
        headers: withLoopback(
          { Origin: `http://127.0.0.1:${String(h.server.boundPort)}` },
          h.server.boundPort,
        ),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Mutating routes CSRF + auth posture', () => {
    it('POST without bearer token returns 401', async () => {
      const res = await fetch(`${h.baseUrl}/oauth/callback/github`, {
        method: 'POST',
        headers: withLoopback({ 'Content-Type': 'application/json' }, h.server.boundPort),
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('POST with form-encoded content type returns 415', async () => {
      const res = await fetch(`${h.baseUrl}/oauth/callback/github`, {
        method: 'POST',
        headers: withLoopback(
          {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${h.server.sessionAuth.token}`,
          },
          h.server.boundPort,
        ),
        body: 'a=b',
      });
      expect(res.status).toBe(415);
    });

    it('POST with multipart content type returns 415', async () => {
      const res = await fetch(`${h.baseUrl}/oauth/callback/github`, {
        method: 'POST',
        headers: withLoopback(
          {
            'Content-Type': 'multipart/form-data; boundary=x',
            Authorization: `Bearer ${h.server.sessionAuth.token}`,
          },
          h.server.boundPort,
        ),
        body: '--x--',
      });
      expect(res.status).toBe(415);
    });
  });

  describe('Security headers', () => {
    it('responses include a Content-Security-Policy header', async () => {
      const res = await fetch(`${h.baseUrl}/health`, {
        headers: withLoopback({}, h.server.boundPort),
      });
      const csp = res.headers.get('content-security-policy');
      expect(csp).not.toBeNull();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain(`ws://127.0.0.1:${String(h.server.boundPort)}`);
    });

    it('responses include X-Content-Type-Options nosniff', async () => {
      const res = await fetch(`${h.baseUrl}/health`, {
        headers: withLoopback({}, h.server.boundPort),
      });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  describe('Session token storage', () => {
    it('writes the session token file with 0600 perms', () => {
      const tokenPath = h.server.sessionAuth.tokenPath;
      const stat = statSync(tokenPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('token is a 64-char hex string', () => {
      expect(h.server.sessionAuth.token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('WebSocket auth', () => {
    it('WS connection without bearer is rejected', async () => {
      const url = `ws://127.0.0.1:${String(h.server.boundPort)}/ws`;
      const ws = new WebSocket(url, {
        headers: { Host: `127.0.0.1:${String(h.server.boundPort)}` },
      });
      const result = await new Promise<{ closed: boolean; code?: number }>((resolve) => {
        ws.once('open', () => resolve({ closed: false }));
        ws.once('unexpected-response', (_req, res) => {
          resolve({ closed: true, code: res.statusCode });
        });
        ws.once('error', () => resolve({ closed: true }));
      });
      expect(result.closed).toBe(true);
      ws.terminate();
    });

    it('WS connection with bearer + Origin + Host receives a hello frame', async () => {
      const url = `ws://127.0.0.1:${String(h.server.boundPort)}/ws`;
      const ws = new WebSocket(url, {
        headers: {
          Host: `127.0.0.1:${String(h.server.boundPort)}`,
          Origin: `http://127.0.0.1:${String(h.server.boundPort)}`,
          Authorization: `Bearer ${h.server.sessionAuth.token}`,
        },
      });
      const message = await new Promise<string>((resolve, reject) => {
        ws.once('message', (raw: Buffer) => resolve(raw.toString('utf8')));
        ws.once('error', reject);
      });
      const parsed = JSON.parse(message) as { type: string; version: string };
      expect(parsed.type).toBe('hello');
      expect(parsed.version).toBe('0.0.0-test');
      ws.close();
    });

    it('WS connection with mismatched Origin is rejected', async () => {
      const url = `ws://127.0.0.1:${String(h.server.boundPort)}/ws`;
      const ws = new WebSocket(url, {
        headers: {
          Host: `127.0.0.1:${String(h.server.boundPort)}`,
          Origin: 'http://evil.example.com',
          Authorization: `Bearer ${h.server.sessionAuth.token}`,
        },
      });
      const closed = await new Promise<boolean>((resolve) => {
        ws.once('open', () => resolve(false));
        ws.once('unexpected-response', () => resolve(true));
        ws.once('error', () => resolve(true));
      });
      expect(closed).toBe(true);
      ws.terminate();
    });
  });

  describe('Ephemeral port handling', () => {
    it('port 0 picks an ephemeral port and reports the bound value', () => {
      expect(h.server.boundPort).toBeGreaterThan(0);
      expect(h.server.boundPort).toBeLessThan(65_536);
    });
  });
});
