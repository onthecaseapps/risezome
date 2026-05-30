import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RisezomeError } from '@risezome/shared-types';
import { getDataDir } from '../util/data-dir.js';

export class SessionTokenError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('session-token', message, options);
  }
}

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_FILENAME = 'session-token';

export interface SessionAuth {
  readonly token: string;
  readonly tokenPath: string;
  validateBearer(authorizationHeader: string | undefined): boolean;
}

export async function loadOrCreateSessionAuth(dataDirOverride?: string): Promise<SessionAuth> {
  const dataDir = getDataDir(dataDirOverride);
  const tokenPath = join(dataDir, SESSION_TOKEN_FILENAME);

  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  let token: string;
  // Dev override: RISEZOME_SESSION_TOKEN lets you pin the bearer to a known
  // hex string for curl/script testing. Must be 64 hex chars (32 bytes).
  const envToken = process.env['RISEZOME_SESSION_TOKEN']?.trim();
  if (typeof envToken === 'string' && envToken.length > 0) {
    if (envToken.length !== SESSION_TOKEN_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(envToken)) {
      throw new SessionTokenError(
        `RISEZOME_SESSION_TOKEN must be ${String(SESSION_TOKEN_BYTES * 2)} hex chars (got ${String(envToken.length)})`,
      );
    }
    token = envToken.toLowerCase();
  } else {
    try {
      const existing = await readFile(tokenPath, 'utf8');
      const trimmed = existing.trim();
      if (trimmed.length === SESSION_TOKEN_BYTES * 2) {
        token = trimmed;
      } else {
        token = await rotateSessionToken(tokenPath);
      }
    } catch {
      token = await rotateSessionToken(tokenPath);
    }
  }

  const tokenBuffer = Buffer.from(token, 'hex');
  return {
    token,
    tokenPath,
    validateBearer(authorizationHeader): boolean {
      if (typeof authorizationHeader !== 'string') return false;
      const prefix = 'Bearer ';
      if (!authorizationHeader.startsWith(prefix)) return false;
      const candidate = authorizationHeader.slice(prefix.length).trim();
      if (candidate.length !== token.length) return false;
      let candidateBuffer: Buffer;
      try {
        candidateBuffer = Buffer.from(candidate, 'hex');
      } catch {
        return false;
      }
      if (candidateBuffer.length !== tokenBuffer.length) return false;
      return timingSafeEqual(candidateBuffer, tokenBuffer);
    },
  };
}

async function rotateSessionToken(path: string): Promise<string> {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort chmod on platforms with limited POSIX support.
  }
  return token;
}

const ALLOWED_LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

export function isAllowedHost(hostHeader: string | undefined, expectedPort: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  const [hostname, portStr] = hostHeader.split(':');
  if (hostname === undefined || portStr === undefined) return false;
  if (!ALLOWED_LOCAL_HOSTNAMES.has(hostname)) return false;
  return Number(portStr) === expectedPort;
}

export function isAllowedOrigin(originHeader: string | undefined, expectedPort: number): boolean {
  if (typeof originHeader !== 'string') return false;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
  if (!ALLOWED_LOCAL_HOSTNAMES.has(url.hostname)) return false;
  return Number(url.port) === expectedPort;
}
