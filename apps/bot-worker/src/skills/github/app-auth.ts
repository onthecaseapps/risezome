import { createSign } from 'node:crypto';

/**
 * GitHub App installation-token minter.
 *
 * Mirrors what the portal's `getInstallationOctokit` does (via
 * `@octokit/app`), but without the dependency — we mint the App JWT
 * with node:crypto (RS256) and exchange it for a per-installation
 * access token via the REST API. The bot-worker only needs read access
 * to issues/PRs, so a token-string + the existing GithubClient is
 * lighter than pulling in the full Octokit stack.
 *
 * Credentials are PLATFORM secrets (one GitHub App for all tenants):
 *   - GITHUB_APP_ID
 *   - GITHUB_APP_PRIVATE_KEY_BASE64  (base64-encoded PEM; newlines
 *     survive env transport this way, matching the portal)
 *
 * Customers never set these — they install the GitHub App on their own
 * org via the Sources page, which writes a `sources` row carrying the
 * numeric installation_id. The resolver maps a meeting's orgId →
 * installation_id → token via this class.
 *
 * Installation tokens last 60 minutes; we cache per-installation and
 * refresh when within a 5-minute expiry margin. The App JWT itself is
 * minted fresh per token exchange (cheap; it's just a signature).
 */

export interface GithubAppAuthOptions {
  readonly appId: string;
  /** Decoded PEM (NOT base64). buildGithubAppAuth handles the decode. */
  readonly privateKeyPem: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

const GITHUB_API = 'https://api.github.com';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class GithubAppAuth {
  readonly #appId: string;
  readonly #privateKeyPem: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<number, CachedToken>();

  constructor(options: GithubAppAuthOptions) {
    this.#appId = options.appId;
    this.#privateKeyPem = options.privateKeyPem;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Return a valid installation access token for the given
   * installation, minting (and caching) a fresh one when the cache is
   * empty or close to expiry.
   */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.#cache.get(installationId);
    if (cached !== undefined && cached.expiresAtMs - this.#now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const jwt = this.#mintAppJwt();
    const res = await this.#fetch(
      `${GITHUB_API}/app/installations/${String(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'risezome-bot-worker',
        },
      },
    );
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(
        `GitHub App token exchange failed for installation ${String(installationId)} (${String(res.status)}): ${body}`,
      );
    }
    const data = (await res.json()) as { token?: string; expires_at?: string };
    if (typeof data.token !== 'string' || data.token.length === 0) {
      throw new Error(`GitHub App token exchange returned no token for installation ${String(installationId)}`);
    }
    const expiresAtMs =
      typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : this.#now() + 55 * 60 * 1000;
    this.#cache.set(installationId, { token: data.token, expiresAtMs });
    return data.token;
  }

  /**
   * Mint a short-lived App JWT (RS256). `iat` is backdated 60s for clock
   * skew; `exp` is +9 minutes (GitHub caps App JWTs at 10 minutes).
   */
  #mintAppJwt(): string {
    const nowSec = Math.floor(this.#now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: this.#appId }),
    );
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.#privateKeyPem).toString('base64url');
    return `${signingInput}.${signature}`;
  }
}

/**
 * Build a GithubAppAuth from env, or return null when the App
 * credentials aren't configured (live GitHub skills then stay
 * disabled — logged by the registry builder).
 */
export function buildGithubAppAuth(
  env: NodeJS.ProcessEnv = process.env,
): GithubAppAuth | null {
  const appId = env.GITHUB_APP_ID;
  const keyB64 = env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (appId === undefined || appId.length === 0) return null;
  if (keyB64 === undefined || keyB64.length === 0) return null;
  const privateKeyPem = Buffer.from(keyB64, 'base64').toString('utf8');
  return new GithubAppAuth({ appId, privateKeyPem });
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
