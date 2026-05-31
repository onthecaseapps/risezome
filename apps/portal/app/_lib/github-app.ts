import { App } from '@octokit/app';

// We don't depend on @octokit/core directly; let TypeScript infer the
// Octokit type returned by App.getInstallationOctokit() rather than
// importing the type and forcing a peer-dependency surface we don't need.
type AppInstallationOctokit = Awaited<ReturnType<App['getInstallationOctokit']>>;

/**
 * Risezome GitHub App. One App owned by the platform; many installations
 * (one per beta-tester org). This factory caches a single `App` instance
 * for the process and exposes `getInstallationOctokit(id)` that returns
 * an Octokit client scoped to a specific installation. The underlying
 * `@octokit/app` library caches installation access tokens for 59 minutes
 * (token lifetime is 60); no manual refresh loop needed.
 *
 * Private key: stored in env as base64 (GITHUB_APP_PRIVATE_KEY_BASE64)
 * because PEM newlines get mangled by Vercel + most env-var inputs.
 * Decoded once at module-init time.
 *
 * Webhook secret: NOT used by this client; webhook signature verification
 * lives in the webhook route handler (`apps/portal/app/api/github/webhook/route.ts`).
 */

let cachedApp: App | null = null;

function buildApp(): App {
  const appId = requireEnv('GITHUB_APP_ID');
  const privateKeyB64 = requireEnv('GITHUB_APP_PRIVATE_KEY_BASE64');
  const privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');
  // Webhook secret is included for symmetry with @octokit/app's constructor
  // signature; the webhook handler in U4b verifies signatures directly using
  // Node's crypto rather than relying on @octokit/webhooks. Either path is
  // valid; the handler picks the explicit verification for clarity.
  const webhookSecret = requireEnv('GITHUB_APP_WEBHOOK_SECRET');

  return new App({
    appId,
    privateKey,
    webhooks: { secret: webhookSecret },
  });
}

export function getApp(): App {
  if (cachedApp === null) {
    cachedApp = buildApp();
  }
  return cachedApp;
}

/**
 * Octokit client scoped to a specific GitHub App installation.
 * @octokit/app caches the installation access token internally for 59 min.
 */
export async function getInstallationOctokit(installationId: number): Promise<AppInstallationOctokit> {
  const app = getApp();
  return await app.getInstallationOctokit(installationId);
}

/**
 * Public install URL for a beta tester to install the Risezome App on
 * their own GitHub org. Optionally takes a `state` param that GitHub
 * echoes back to our install-callback for CSRF binding.
 */
export function getInstallUrl(state?: string): string {
  const slug = requireEnv('GITHUB_APP_SLUG');
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  if (state !== undefined && state.length > 0) {
    url.searchParams.set('state', state);
  }
  return url.toString();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Run apps/portal/scripts/register-github-app.mjs to generate values and paste them into apps/portal/.env.local.`,
    );
  }
  return value;
}
