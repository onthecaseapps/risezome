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

### 3. (Later units) GitHub App, Recall.ai, Cloudflare Tunnel, Inngest

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
