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

## Dev console (web UI)

`pnpm console` is the point-and-click counterpart to `pnpm dev`: a local web page
to configure the tag + Supabase mode, start/stop/restart each tool, and watch
each process's live, color-coded logs.

```bash
pnpm console            # serves http://localhost:4317 (override with DEV_CONSOLE_PORT)
```

Then open **http://localhost:4317** and:

1. **Set tag + Supabase mode** in the top bar and click **Apply** — this runs the
   same `use-env.sh` the CLI uses (rewrites the active env, remembers the tag in
   `.dev-tag`). Applying a change while processes are running requires a
   **restart** of those processes, since env is read at boot — use each row's
   **restart** button.
2. **Start / stop / restart** any process, or **Start all / Stop all** (Supabase
   first in local mode, tunnel last, reverse on stop). On start, the console
   **auto-creates your per-developer cloudflared tunnel** if it doesn't exist yet
   (`risezome-dev-<tag>` named tunnel + DNS routes + config — see below). You only
   need to do the one-time `cloudflared tunnel login` first; if cloudflared is
   missing or not authenticated, the tunnel pane tells you exactly what to run and
   the rest of the stack still comes up.
3. **Open a tool** — the **Links** panel at the top lists clickable URLs for
   every tool that's up (portal, Inngest, bot-worker health, Supabase Studio/API
   in local mode, and your tunnel hostnames once it's running).
4. **Reset DB on start** (top-bar toggle, default **off**) — off means a cold
   Supabase start runs `supabase migration up` (applies new migrations, **keeps
   your local data**); on means `supabase db reset` (wipes + re-seeds). A stack
   that's already running is never touched either way.
5. **Watch logs** — a pinned **Console** panel at the top shows what step the
   console is on (starting Supabase, tunnel setup, launching) plus the tunnel
   creation output, and each process has its own pane below (⤢ expands one to
   full screen, Esc collapses). ANSI colors are preserved and error/warn lines
   tinted. Everything streams over a single connection, and logs persist to
   `.dev-logs/<name>.log` (gitignored) so a process that outlives the console can
   still be `grep`-ed.

The console binds `127.0.0.1` only and has no auth — it's a localhost dev tool.
It's the **parent** process: Ctrl-C (or closing it) tears down everything it
started. Processes you started outside the console (or that survived a console
restart) still read as **running** via a port check, but their live log only
resumes for output the console itself captures — stop-all before quitting is the
clean path.

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
(applies the migrations; the seed is empty). The stack comes up with the
schema and no rows — sign in at http://localhost:3000 with **Google** (the
same flow as prod) and onboard normally (create a workspace, connect sources),
generating real local data.

Google sign-in against the local stack needs your `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` in `apps/portal/.env.dev` (the local
`supabase/config.toml` wires the Google provider from those env vars), and your
Google OAuth client must allow the local redirect
`http://localhost:3000/api/auth/callback`.

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

**You only do the one-time login**; everything else is automated:

```bash
cloudflared tunnel login   # one-time: opens a browser, pick the risezome.app zone
```

After that, the dev console's **Start all** (or `pnpm dev <tag> local --tunnel`)
runs `scripts/ensure-tunnel.sh <tag>`, which idempotently creates the named
tunnel, routes both hostnames' DNS, and writes the ingress config (with
`disableChunkedEncoding: true` for the bot-worker WS). It's a no-op once set up,
so each developer ends up with a **persistent** tunnel. `RISEZOME_DEV_ORIGIN` is
derived as `dev-<tag>.risezome.app`, so Next dev hydrates over your tunnel
automatically.

> **Hosted-mode guard (security).** The tunnel exposes `localhost:3000`/`:8787`
> to the public internet. In **hosted** Supabase mode those are backed by a real
> database, so both the console and `pnpm dev` **refuse to start the tunnel in
> hosted mode** unless you set `RISEZOME_TUNNEL_HOSTED_OK=1`. Use the tunnel with
> **local** mode (throwaway data), or put Cloudflare Access in front of the
> hostname before overriding.

See [`persistent-bot-worker-tunnel.md`](./persistent-bot-worker-tunnel.md) for
the underlying recipe `ensure-tunnel.sh` automates, and for teardown
(`cloudflared tunnel delete risezome-dev-<tag>`).

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
- **`supabase db reset` wipes local data.** The dev console only resets on a cold
  start when the **"reset DB on start"** toggle is on (default off → it runs
  `migration up` and keeps your data); `pnpm dev` resets only when it had to
  _start_ the stack fresh. Neither ever resets a stack that's already running.
- **After pulling new migrations**, re-apply to your target: local →
  `supabase db reset` (re-applies migrations), hosted → `supabase db push`. Otherwise your
  schema drifts from the code.
- **Restart after env / `next.config.mjs` changes** — both the portal and the
  bot-worker read env at boot; `allowedDevOrigins` is build-time.
- **Never commit** `.env.dev`, `.env.local`, `.env`, or `.dev-tag` (all
  gitignored). The local demo Supabase keys are public and non-secret; your
  hosted keys and `BOT_WORKER_SECRET` are not.
- **Don't duplicate secrets on disk.** Avoid `sed -i.bak` (or any editor backup)
  on `.env*` files — it leaves `.env.bak` copies of live secrets lying around
  (`*.bak` is gitignored, but the copies are still real keys on your machine).
  Prefer a secret manager (`op run -- pnpm dev`, 1Password/Doppler/Vault) over
  on-disk `.env` files. Keep the **production** `USER_TOKEN_ENCRYPTION_KEY`
  distinct from any value in your dev `.env` files, so a dev-machine compromise
  never yields the key that protects production tokens.
- **`.dev-logs/` holds raw process output** (which can include transcripts and,
  before redaction, auth tokens). It's gitignored, but treat it as sensitive:
  the dev console's **Clear logs** button (or `: > .dev-logs/*.log`) scrubs it.
