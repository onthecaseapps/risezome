# Two-developer local setup (isolated)

Run the whole stack with **one command**, and keep two developers from stepping
on each other — separate Supabase data, separate tunnel hostnames, separate
Recall bots. Everything is keyed off a single **developer tag** (e.g. `nathan`).

## Day to day

```bash
pnpm dev                 # local Supabase, remembered tag, all logs in one stream
pnpm dev nathan hosted   # use your own hosted Supabase project instead
pnpm dev --no-supabase   # don't start/seed the local stack (you manage it)
pnpm dev --tunnel        # also run your per-dev cloudflared tunnel
```

`pnpm dev` resolves your tag (prompts once, remembers it in `.dev-tag`), wires
the env, brings up the local Supabase stack (in local mode), and launches
portal + Inngest + bot-worker (+ tunnel) with one prefixed, color-coded log
stream. **Ctrl-C stops everything together.**

Ports are unchanged: portal `:3000`, Inngest `:8288`, bot-worker `:8787`. Two
developers on two machines don't collide on ports — the collisions this setup
removes are the shared **Supabase**, **tunnel**, and **Recall** surfaces.

## One-time setup

### 1. Your env files

Each developer fills one file per app, once:

```bash
cp apps/portal/.env.example      apps/portal/.env.dev
cp apps/bot-worker/.env.example  apps/bot-worker/.env.dev
```

Fill in your secrets. Notes:

- `BOT_WORKER_SECRET` must be the **same value** in both files.
- Leave `RISEZOME_DEV_ORIGIN` / `BOT_WORKER_BASE_URL` unset — they're derived
  from your tag by `pnpm dev`.
- These `.env.dev` files are gitignored. So is the generated `.env.local` /
  `.env` — never edit those by hand, and never commit secrets.

### 2. Pick a Supabase mode

**Local stack (recommended, free, fully isolated per machine):**
`pnpm dev` runs `supabase start` (needs Docker) and `supabase db reset`
(migrations + seed). Then sign in at http://localhost:3000 with the seeded user:

```
email:    dev@risezome.test
password: devpassword
```

**Hosted (your own project):** create a Supabase project, then:

```bash
supabase link --project-ref <your-ref>
supabase db push
```

Put your project URL + publishable + secret keys into both `.env.dev` files and
run `pnpm dev <tag> hosted`.

The active env is generated for you; the Supabase var-name mapping is handled by
`scripts/use-env.sh` (see the matrix below).

### 3. Per-dev tunnel (only for real Recall bots / sharing your portal)

A cloudflared tunnel is owned by one Cloudflare account, so each developer runs
their **own** named tunnel with **one-level** subdomains (Cloudflare's free
Universal SSL doesn't cover two-level subdomains — `dev-nathan.risezome.app` ✅,
`nathan.dev.risezome.app` ❌):

- Tunnel: `risezome-dev-<tag>`, config at `~/.cloudflared/risezome-dev-<tag>.yml`.
- Hostnames: `dev-<tag>.risezome.app` → `:3000`, `bot-worker-dev-<tag>.risezome.app` → `:8787`.

See [`persistent-bot-worker-tunnel.md`](./persistent-bot-worker-tunnel.md) for
the tunnel creation recipe (login, `tunnel create`, `tunnel route dns`, the
ingress YAML with `disableChunkedEncoding: true` for WS). Then `pnpm dev <tag>
local --tunnel`. `RISEZOME_DEV_ORIGIN` is derived as `dev-<tag>.risezome.app`, so
Next dev hydrates over your tunnel automatically.

### 4. Per-dev Recall Environment (for real bot isolation)

Recall has **no per-bot webhook** and `realtime_endpoints` can't carry lifecycle
events — the supported isolation is a per-developer **Environment** (Recall
dashboard → Environments; 50/org, no extra fee):

1. Create your own Environment; grab its API key.
2. Set that Environment's webhook URL to your tunnel
   (`https://bot-worker-dev-<tag>.risezome.app/...` per the Recall webhook docs).
3. Put `RECALL_API_KEY` + `RECALL_WEBHOOK_SECRET` (from your Environment) into
   `apps/portal/.env.dev`. `BOT_WORKER_BASE_URL` (the wss host bots dial) is
   derived from your tag, so your bots stream to **your** bot-worker.

**Fallback** (sharing one Environment): set `RECALL_DEVELOPER_ID=<tag>` so each
bot is tagged, and demux by `metadata.developer_id` in the webhook handler. Until
that's built, the dev who doesn't own the dashboard webhook can use the manual
end-meeting button to fire recap/gaps locally.

## Env matrix (handled by `use-env.sh`)

The same Supabase values are written under each surface's expected var names:

| Surface             | URL var                    | Key var(s)                                       |
| ------------------- | -------------------------- | ------------------------------------------------ |
| Portal browser/SSR  | `NEXT_PUBLIC_SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`           |
| Portal service-role | `NEXT_PUBLIC_SUPABASE_URL` | `SUPABASE_SECRET_KEY`                            |
| Bot-worker          | `SUPABASE_URL`             | `SUPABASE_SECRET_KEY`                            |
| RLS tests           | `SUPABASE_URL`             | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

In local mode these come from the running `supabase start` stack (or the
well-known local demo keys). In hosted mode they come from your `.env.dev`.

## Footguns

- **RLS tests silently skip** unless a local Supabase stack is up _and_
  `RISEZOME_RUN_RLS_TESTS=1` is set — skipped ≠ passed. To actually exercise RLS:
  `pnpm dev <tag> local` (or `supabase start`), then
  `RISEZOME_RUN_RLS_TESTS=1 pnpm --filter @risezome/portal test`.
- **`supabase db reset` wipes local data.** `pnpm dev` only resets when it had to
  _start_ the stack fresh; it never resets a stack you're already running.
- **After pulling new migrations**, re-apply to your target: local →
  `supabase db reset` (re-seeds), hosted → `supabase db push`. Otherwise your
  schema drifts from the code.
- **Restart after env / `next.config.mjs` changes** — both the portal and the
  bot-worker read env at boot; `allowedDevOrigins` is build-time.
- **Never commit** `.env.dev`, `.env.local`, `.env`, or `.dev-tag` (all
  gitignored). The local demo Supabase keys are public and non-secret; your
  hosted keys and `BOT_WORKER_SECRET` are not.
