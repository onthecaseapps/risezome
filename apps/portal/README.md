# @risezome/portal

The hosted Risezome portal — Next.js 16 App Router app on Vercel. Hosts both the
public marketing surface (`/`, `/sign-in`) and authenticated routes
(`/onboarding`, `/sources`, `/meetings`, `/settings`) once subsequent
implementation units land.

Implementation plan: [`docs/plans/2026-05-30-002-feat-upwell-portal-saas-plan.md`](../../docs/plans/2026-05-30-002-feat-upwell-portal-saas-plan.md).

## Local development

```bash
pnpm install
cp apps/portal/.env.example apps/portal/.env.local
# Fill in the env vars per .env.example
pnpm --filter @risezome/portal dev   # http://localhost:3000
```

## One-time platform setup

The portal needs accounts/credentials on several external services. Walk
through these once per environment; the values land in `.env.local` (dev) or
Vercel project env vars (prod).

### 1. Supabase

1. Create a project at https://app.supabase.com — region **us-east-1**, free
   tier is fine for beta.
2. Settings → API: copy the **URL**, the **publishable key** (formerly anon),
   and the **secret key** (formerly service_role) into `.env.local` as
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SECRET_KEY` respectively.
3. Install the Supabase CLI: `brew install supabase/tap/supabase` (or see
   https://supabase.com/docs/guides/cli).
4. Install Docker Desktop (needed for `supabase start`).
5. From the repo root: `supabase login` then
   `supabase link --project-ref <your-ref>`.
6. Apply migrations: `supabase db push`. Local dev against a Docker stack:
   `supabase start` then `supabase db reset`.

### 2. Google OAuth (Sign-In + Calendar)

1. Create a Google Cloud project at https://console.cloud.google.com.
2. APIs & Services → Credentials → "OAuth 2.0 Client ID" → Web application.
3. Authorized redirect URIs:
   - `https://<your-supabase-ref>.supabase.co/auth/v1/callback`
   - `http://localhost:3000/api/auth/callback`
4. Copy the client ID + secret into `.env.local` as `GOOGLE_OAUTH_CLIENT_ID`
   and `GOOGLE_OAUTH_CLIENT_SECRET`.
5. In Supabase Dashboard → Auth → Providers → Google: enable the provider,
   paste the same client ID + secret.
6. Verify the domain you'll deploy at (`risezome.app`) in Google Cloud Console
   ahead of time so Calendar Push notifications (U6) work in prod.

### 3. GitHub App (one-time platform registration)

The Risezome GitHub App is a single platform-owned object (owned by the
`onthecaseapps` GitHub org) that beta testers install on their own orgs to
let us index their repos. This is a **one-time setup** done by an Upwell
operator; testers do not run this — they click an Install link served by
U4b's per-tester install flow.

Run the registration script:

```bash
node apps/portal/scripts/register-github-app.mjs
```

The script:
1. Hosts a tiny local web server at http://localhost:7000
2. Auto-opens your browser; click "Submit manifest to GitHub"
3. Review the manifest on GitHub (App name, permissions, webhook URL)
   under the `onthecaseapps` org, then click "Create GitHub App for me"
4. GitHub redirects back to localhost; the script exchanges the temp code
   and prints credentials to both the terminal and the browser tab
5. Paste the printed `GITHUB_APP_*` env vars into `apps/portal/.env.local`
   (and later into Vercel project env when deploying)

Configurable via env vars (defaults shown):
- `RZ_APP_NAME` — display name on GitHub (default: `Risezome`, or `Risezome (Dev)` for a local host)
- `RZ_APP_OWNER` — GitHub org/user to own the App (default: `onthecaseapps`)
- `RZ_APP_HOST` — hostname for the App's callback/setup/webhook URLs (default: `risezome.app`).
  If this starts with `localhost` or `127.`, the script switches to `http://` and registers a
  dev-mode App with the webhook inactive (use `RZ_WEBHOOK_URL` to override).
- `RZ_WEBHOOK_URL` — override the App's webhook URL (e.g. a smee.io / ngrok tunnel for dev)
- `RZ_LOCAL_PORT` — local server port for the registration callback (default: `7000`)

**Dev pattern: register TWO Apps.** One `Risezome` (prod) for beta testers, one `Risezome (Dev)`
(local) for your own development. Each is a separate object in GitHub with its own credentials;
they never collide.

```bash
# 1. Prod App (one-time, before first deploy):
node apps/portal/scripts/register-github-app.mjs

# 2. Dev App (one-time, for local testing):
RZ_APP_HOST="localhost:3000" node apps/portal/scripts/register-github-app.mjs
# → registers "Risezome (Dev)" with http://localhost:3000/... URLs, webhook inactive.
# Paste the resulting credentials into apps/portal/.env.local (overwriting any
# prod credentials there — prod credentials live in Vercel env, not .env.local).
```

The credentials printed:
- `GITHUB_APP_ID` — numeric app id, public
- `GITHUB_APP_SLUG` — public install-URL slug (e.g. `risezome`)
- `GITHUB_APP_CLIENT_ID` — for user-OAuth flows (future)
- `GITHUB_APP_CLIENT_SECRET` — **secret**, server-only
- `GITHUB_APP_WEBHOOK_SECRET` — **secret**, verifies inbound webhooks
- `GITHUB_APP_PRIVATE_KEY_BASE64` — **secret**, base64-encoded PEM. Encoded
  because PEM newlines get mangled by most hosting providers' env-var inputs;
  `app/_lib/github-app.ts` decodes at load time.

### 4. Per-tester install + webhook delivery (U4b)

The Risezome GitHub App is one platform-owned object; each beta tester
installs it on their own org. The flow:

1. Tester signs in and goes to `/sources` → clicks **Connect GitHub**
2. Browser hits `/sources/install` (server route). We mint a CSRF state
   token, store it in `pending_installations` (15-min TTL) bound to the
   user+org, then 302 to `https://github.com/apps/<slug>/installations/new?state=<token>`
3. Tester picks an org + repos on GitHub
4. GitHub redirects to `/api/github/install-callback?installation_id=...&state=...`.
   We verify the state, fetch installation metadata via the App's JWT, and
   upsert `github_installations` + insert `sources` rows
5. In parallel, GitHub POSTs webhook events to `/api/github/webhook` —
   `installation.created`, `installation_repositories.added`, etc. The
   handler verifies `X-Hub-Signature-256` with HMAC-SHA-256 against
   `GITHUB_APP_WEBHOOK_SECRET` (constant-time comparison) before any DB write

Additional env var for the install flow:

- `INSTALL_STATE_HMAC_SECRET` — reserved for a future server-side HMAC of
  the state token if we move off the DB-backed `pending_installations`
  table. Generate with `openssl rand -base64 32`. Not currently consumed.

**Local webhook testing:** the registration script writes the production
webhook URL (`https://<RZ_APP_HOST>/api/github/webhook`) into the App.
For local testing, use `gh webhook forward` or a tunnel (Cloudflare /
ngrok) and override `Webhook URL` in the App's settings under
`https://github.com/organizations/onthecaseapps/settings/apps/<slug>`.

### 5. Inngest + Voyage (U5: indexer)

The indexer runs as an Inngest function (`apps/portal/src/inngest/functions/index-repo.ts`)
triggered by the `risezome/source.index-requested` event. The install-callback
fans out one event per granted repo; user-initiated Reindex (U5d) emits the
same event.

**Voyage API key** (`VOYAGE_API_KEY`): create at
[https://dash.voyageai.com/api-keys](https://dash.voyageai.com/api-keys).
Paid plan recommended once you exceed the free-tier 10k TPM. Server-only.

**Inngest production:** the Vercel-Inngest integration handles registration
+ signing-key provisioning. One-time setup: visit the Inngest dashboard,
connect the Vercel project, and the integration writes
`INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` into the Vercel env.

**Inngest local dev (no cloud account needed):**

```bash
# Terminal 1: portal dev server (exposes /api/inngest at localhost:3000)
pnpm --filter @risezome/portal dev

# Terminal 2: Inngest dev CLI (auto-discovers functions; UI at localhost:8288)
npx inngest-cli@latest dev
```

The dev CLI runs functions in-process against your local portal — when an
install-callback or webhook handler calls `inngest.send(...)`, the dev CLI
picks it up and runs `index-repo` against the local Supabase stack. Leave
`INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` unset in `.env.local`; the SDK
auto-detects dev mode and skips signing.

The Inngest UI at `http://localhost:8288` shows event flow, step traces,
retry attempts, and lets you replay events. Use it to debug indexer runs
without poking through Supabase row-by-row.

### 6. (Later units) Recall.ai, Fly.io (bot-worker)

Documented as each unit lands. See the plan's `Documentation / Operational
Notes` section for the full inventory.

## Test commands

```bash
pnpm --filter @risezome/portal typecheck
pnpm --filter @risezome/portal test
pnpm --filter @risezome/portal lint
pnpm --filter @risezome/portal build
```

The RLS tests (`test/rls/*.test.ts`) require a running `supabase start`
local stack and skip otherwise. Set `RISEZOME_RUN_RLS_TESTS=1` to require
them in CI environments where Docker is available.
