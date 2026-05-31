#!/usr/bin/env node
/**
 * One-shot operator runbook to register the Risezome GitHub App under the
 * `onthecaseapps` org via GitHub's App Manifest flow.
 *
 * Manifest flow (per https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
 *   1. We POST a manifest JSON to GitHub's app-create UI (org-scoped URL).
 *   2. User reviews the manifest in their browser, clicks "Create GitHub App for me".
 *   3. GitHub redirects to our redirect_url with ?code=<temp>&state=<csrf>.
 *   4. We exchange the temp code at POST /app-manifests/{code}/conversions
 *      within 1 hour to receive {id, pem, webhook_secret, client_id, client_secret}.
 *   5. Operator pastes those outputs into Vercel project env (or .env.local for dev).
 *
 * This script automates steps 1-4 by hosting a tiny local web server at
 * http://localhost:7000 that:
 *   - Serves an HTML page at / that auto-submits the manifest to GitHub
 *   - Listens at /callback for GitHub's redirect, exchanges the code,
 *     and prints the credentials to stdout.
 *
 * Per-tester App INSTALLATION is a different flow handled in U4b — this
 * script is for the ONE-TIME creation of the App itself, run once per
 * environment by the platform operator (Nathan).
 *
 * Usage:
 *   node apps/portal/scripts/register-github-app.mjs
 *   # then follow the printed instructions.
 *
 * Env vars (optional, see DEFAULTS below for sane fallbacks):
 *   - RZ_APP_NAME              Display name on GitHub (default: "Risezome")
 *   - RZ_APP_HOST              Production hostname (default: "risezome.app")
 *   - RZ_APP_OWNER             GitHub org/user to own the App (default: "onthecaseapps")
 *   - RZ_LOCAL_PORT            Local server port (default: 7000)
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';

const DEFAULTS = {
  appName: process.env.RZ_APP_NAME ?? 'Risezome',
  appHost: process.env.RZ_APP_HOST ?? 'risezome.app',
  appOwner: process.env.RZ_APP_OWNER ?? 'onthecaseapps',
  localPort: parseInt(process.env.RZ_LOCAL_PORT ?? '7000', 10),
};

// CSRF state token — bound to this run. GitHub echoes it back; we verify.
const stateToken = randomBytes(16).toString('hex');
const stateHash = createHash('sha256').update(stateToken).digest('hex').slice(0, 16);

/**
 * Manifest payload submitted to GitHub.
 *
 * Permissions kept to the minimum: contents:read for source indexing,
 * issues+pull_requests:read for the live-skills layer (issues, PR status).
 * metadata:read is implicit/required for every app.
 *
 * default_events covers what U4b's webhook needs:
 *   - push: trigger incremental reindex on commits
 *   - pull_request, issues: corpus freshness events
 *
 * Note: `installation` and `installation_repositories` are NOT in
 * default_events because they're not subscribable webhook events —
 * they're App-lifecycle events GitHub delivers automatically to every
 * App regardless of the events list. (Earlier draft included them and
 * GitHub rejected the manifest with "Default events unsupported".)
 *
 * Production URLs use https://${appHost}. Local-dev install flow is
 * handled separately by U4b's /sources/install route serving a redirect
 * to the public install page at github.com/apps/<slug>/installations/new.
 */
const manifest = {
  name: DEFAULTS.appName,
  url: `https://${DEFAULTS.appHost}`,
  hook_attributes: {
    url: `https://${DEFAULTS.appHost}/api/github/webhook`,
    active: true,
  },
  redirect_url: `http://localhost:${DEFAULTS.localPort}/callback`,
  callback_urls: [`https://${DEFAULTS.appHost}/api/github/install-callback`],
  setup_url: `https://${DEFAULTS.appHost}/sources`,
  setup_on_update: true,
  public: true,
  default_permissions: {
    contents: 'read',
    metadata: 'read',
    issues: 'read',
    pull_requests: 'read',
  },
  default_events: ['push', 'pull_request', 'issues'],
};

function htmlAutoSubmitForm() {
  const manifestJson = JSON.stringify(manifest);
  const escapedManifest = manifestJson.replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // Form posts to GitHub's org-scoped manifest endpoint, taking the
  // operator to the App-creation review screen.
  const action = `https://github.com/organizations/${encodeURIComponent(DEFAULTS.appOwner)}/settings/apps/new?state=${stateToken}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Register ${DEFAULTS.appName} GitHub App</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 24px; color: #1a1a1c; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { color: #555; line-height: 1.5; }
    button { font-size: 15px; padding: 10px 18px; border-radius: 8px; border: none; background: #5159e0; color: white; cursor: pointer; }
    button:hover { background: #6b72f0; }
    code { background: #f4f4f7; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Register ${DEFAULTS.appName} GitHub App</h1>
  <p>
    Click below to submit the App manifest to GitHub under the
    <code>${DEFAULTS.appOwner}</code> org. You'll see GitHub's review screen
    with the App name, permissions, and webhook URL — review them and click
    <em>"Create GitHub App for me"</em>.
  </p>
  <p>
    After GitHub creates the App, it redirects back here. This window will
    show the App credentials; copy them into your Vercel env vars or
    <code>apps/portal/.env.local</code>.
  </p>
  <form action="${action}" method="post">
    <input type="hidden" name="manifest" value="${escapedManifest}" />
    <button type="submit">Submit manifest to GitHub →</button>
  </form>
</body>
</html>
`;
}

function htmlResult(creds) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>App registered</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 60px auto; padding: 0 24px; color: #1a1a1c; }
    h1 { font-size: 20px; margin-bottom: 16px; }
    .ok { color: #28a745; font-weight: 600; }
    code { display: block; background: #f4f4f7; padding: 14px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 13px; white-space: pre-wrap; word-break: break-all; margin: 6px 0 18px; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <h1><span class="ok">✓</span> GitHub App "${creds.name}" registered</h1>
  <p>
    The App lives at <a href="${creds.html_url}" target="_blank">${creds.html_url}</a>.
    Per-tester install URL: <code>https://github.com/apps/${creds.slug}/installations/new</code>.
  </p>
  <p>Paste the following into <strong>apps/portal/.env.local</strong> (and later into Vercel env vars):</p>
  <code>GITHUB_APP_ID=${creds.id}
GITHUB_APP_SLUG=${creds.slug}
GITHUB_APP_CLIENT_ID=${creds.client_id}
GITHUB_APP_CLIENT_SECRET=${creds.client_secret}
GITHUB_APP_WEBHOOK_SECRET=${creds.webhook_secret}
GITHUB_APP_PRIVATE_KEY_BASE64=${Buffer.from(creds.pem).toString('base64')}</code>
  <p>
    The private key is base64-encoded above. <code>apps/portal/app/_lib/github-app.ts</code>
    decodes it at load time (env-var newlines are mangled in most hosting providers; base64
    is the safe transport).
  </p>
  <p>You can close this window — script will exit on its own.</p>
</body>
</html>
`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${DEFAULTS.localPort}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlAutoSubmitForm());
    return;
  }

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (state !== stateToken) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('State token mismatch — possible CSRF. Re-run the script.');
      console.error('\n✗ State mismatch. Got:', state, 'Expected:', stateToken);
      process.exit(1);
      return;
    }
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Missing ?code= in callback URL.');
      console.error('\n✗ No code in callback.');
      process.exit(1);
      return;
    }

    try {
      const apiRes = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'risezome-register-script',
        },
      });
      const body = await apiRes.json();
      if (!apiRes.ok) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`GitHub returned ${apiRes.status}: ${JSON.stringify(body)}`);
        console.error('\n✗ Manifest exchange failed:', apiRes.status, body);
        process.exit(1);
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlResult(body));

      // Print to stdout too in case the browser is closed.
      console.log('\n✓ App registered successfully.\n');
      console.log(`Name:           ${body.name}`);
      console.log(`Slug:           ${body.slug}`);
      console.log(`App ID:         ${body.id}`);
      console.log(`Install URL:    https://github.com/apps/${body.slug}/installations/new`);
      console.log(`Owner:          ${body.owner.login}`);
      console.log('');
      console.log('--- Paste into apps/portal/.env.local ---');
      console.log(`GITHUB_APP_ID=${body.id}`);
      console.log(`GITHUB_APP_SLUG=${body.slug}`);
      console.log(`GITHUB_APP_CLIENT_ID=${body.client_id}`);
      console.log(`GITHUB_APP_CLIENT_SECRET=${body.client_secret}`);
      console.log(`GITHUB_APP_WEBHOOK_SECRET=${body.webhook_secret}`);
      console.log(`GITHUB_APP_PRIVATE_KEY_BASE64=${Buffer.from(body.pem).toString('base64')}`);
      console.log('');
      console.log(`State hash (for the runbook log): ${stateHash}`);

      // Give the browser ~5s to render the result page, then exit.
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 5_000);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Exchange failed: ${err.message ?? String(err)}`);
      console.error('\n✗ Exchange error:', err);
      process.exit(1);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found.');
});

server.listen(DEFAULTS.localPort, () => {
  const localUrl = `http://localhost:${DEFAULTS.localPort}`;
  console.log(`
Risezome GitHub App registration runbook
========================================

Configuration:
  App name:    ${DEFAULTS.appName}
  Owner org:   ${DEFAULTS.appOwner}
  Prod host:   ${DEFAULTS.appHost}
  Local port:  ${DEFAULTS.localPort}

Server listening at ${localUrl}.

Next:
  1. Open ${localUrl} in your browser
  2. Click "Submit manifest to GitHub"
  3. Review the App settings on GitHub, click "Create GitHub App for me"
  4. GitHub will redirect back here; credentials will print to this terminal
  5. Paste the credentials into apps/portal/.env.local

Press Ctrl+C to abort.
`);

  // Try to open the browser automatically; fall back gracefully if no
  // launcher available (headless dev environment, container, etc.).
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} ${localUrl}`, (err) => {
    if (err !== null) {
      console.log(`(Auto-open failed; open ${localUrl} manually.)`);
    }
  });
});

