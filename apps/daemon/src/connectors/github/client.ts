import { ConnectorAuthError, RateLimitedError } from '../contract.js';
import { redactHeaders, redactString, redactUrl } from '../log-redaction.js';
import type { AuthResult } from '../contract.js';

export interface GithubClientOptions {
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: GithubLogger;
}

export interface GithubLogger {
  log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

export const DEFAULT_GITHUB_BASE_URL = 'https://api.github.com';
const RATE_LIMIT_FLOOR_RATIO = 0.1;

export class GithubClient {
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #logger: GithubLogger | undefined;

  constructor(options: GithubClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_GITHUB_BASE_URL;
    this.#userAgent = options.userAgent ?? 'upwell-daemon';
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#logger = options.logger;
  }

  async get(auth: AuthResult, path: string, query?: Record<string, string>): Promise<Response> {
    const url = new URL(path, this.#baseUrl);
    if (query !== undefined) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    const token = tokenFromAuth(auth);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.#userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
    };

    this.#logger?.log('info', 'github.request', {
      method: 'GET',
      url: redactUrl(url.toString()),
      headers: redactHeaders(headers),
    });

    const res = await this.#fetch(url, { method: 'GET', headers });

    if (res.status === 401 || res.status === 403) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '-1');
      if (remaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0');
        const retryAfterMs = Math.max(0, reset * 1000 - Date.now());
        throw new RateLimitedError(
          `GitHub rate limit exhausted. Retry after ${String(Math.ceil(retryAfterMs / 1000))}s.`,
          retryAfterMs,
        );
      }
      const errorBody = await safeReadText(res);
      throw new ConnectorAuthError(
        `GitHub auth failed (${String(res.status)}): ${redactString(errorBody, [token])}`,
        [],
        { status: res.status },
      );
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      throw new RateLimitedError(
        `GitHub returned 429. retry-after=${String(retryAfter)}s`,
        retryAfter * 1000,
      );
    }

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new ConnectorAuthError(
        `GitHub request failed (${String(res.status)}): ${redactString(body, [token])}`,
        [],
        { status: res.status },
      );
    }

    this.#enforceRateFloor(res);
    return res;
  }

  async getJson<T>(auth: AuthResult, path: string, query?: Record<string, string>): Promise<T> {
    const res = await this.get(auth, path, query);
    return (await res.json()) as T;
  }

  #enforceRateFloor(res: Response): void {
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(res.headers.get('x-ratelimit-limit') ?? Number.MAX_SAFE_INTEGER);
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      const ratio = remaining / limit;
      if (ratio < RATE_LIMIT_FLOOR_RATIO) {
        this.#logger?.log('warn', 'github.rate-limit-low', { remaining, limit });
      }
    }
  }
}

function tokenFromAuth(auth: AuthResult): string {
  if (auth.kind === 'pat') return auth.token;
  return auth.accessToken;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
