# Local dev processes

Last updated: 2026-06-02

The cloud app needs three long-running processes to function locally.
Each in its own terminal; cleanup is `Ctrl-C` per terminal. Run from
the repo root unless noted.

## The three processes

| #   | Process                  | Command                                  | Port    | Notes                                                                                                                                                    |
| --- | ------------------------ | ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Portal** (Next.js)     | `pnpm --filter @risezome/portal dev`     | `:3000` | Web app + Inngest endpoint at `/api/inngest`. Needs `apps/portal/.env.local`.                                                                            |
| 2   | **Inngest dev CLI**      | `npx inngest-cli@latest dev`             | `:8288` | Auto-discovers functions from the portal endpoint. Dashboard at `http://localhost:8288`. Start **after** the portal so discovery succeeds on first poll. |
| 3   | **Bot-worker** (Fastify) | `pnpm --filter @risezome/bot-worker dev` | `:8787` | Long-lived WS server for the Recall.ai bot. Needs `apps/bot-worker/.env`.                                                                                |

Order matters: portal first (Inngest needs the `/api/inngest` endpoint
to register functions), then Inngest CLI, then bot-worker. The
bot-worker is independent and can start any time.

## Quick start (after restart)

```bash
# Terminal 1
pnpm --filter @risezome/portal dev

# Terminal 2 (after portal is responding on :3000)
npx inngest-cli@latest dev

# Terminal 3
pnpm --filter @risezome/bot-worker dev
```

Verify everything is up:

```bash
curl -s http://localhost:3000/api/health 2>&1 || curl -sI http://localhost:3000 | head -1
curl -s http://localhost:8288/health
curl -s http://localhost:8787/health    # → {"ok":true,"runtimes":N}
```

## Optional: public access via the named Cloudflare tunnel

The three processes above are enough for local browsing, Inngest
function dev (calendar sync, repo + issues indexers), and the
bot-worker's `/local-debug` mic surface. You need a **public hostname**
for two things:

- **Sharing the marketing site / portal** with someone off your LAN
  (e.g. a partner reviewing the landing page) → public hostname for `:3000`.
- A **real Recall.ai bot** dialing back into your laptop → public
  hostname for `:8787`.

We run a single **named** Cloudflare tunnel (`risezome-dev`) that serves
both, with **stable** hostnames that survive restarts/crashes (no more
re-pasting random `*.trycloudflare.com` names):

| Hostname                              | → local | Use                                         |
| ------------------------------------- | ------- | ------------------------------------------- |
| `https://dev.risezome.app`            | `:3000` | Portal + marketing site + blog (share this) |
| `https://bot-worker-dev.risezome.app` | `:8787` | Bot-worker WS for real Recall bots          |

### Start it (not auto-started; run after a reboot)

```bash
cloudflared tunnel --config ~/.cloudflared/risezome-dev.yml run
```

Verify:

```bash
curl -s https://dev.risezome.app/            # marketing page HTML
curl -s https://bot-worker-dev.risezome.app/health   # → {"ok":true,"runtimes":N}
```

### What it depends on (one-time setup, already done)

- `cloudflared tunnel login` wrote `~/.cloudflared/cert.pem` (auth to the
  `risezome.app` Cloudflare zone).
- Tunnel `risezome-dev` (id `533ea0fe-…`); credentials at
  `~/.cloudflared/533ea0fe-….json`. Recreate with
  `cloudflared tunnel create risezome-dev` if lost.
- DNS CNAMEs `dev` + `bot-worker-dev` → the tunnel, created with
  `cloudflared tunnel route dns risezome-dev <hostname>`.
- Ingress config at `~/.cloudflared/risezome-dev.yml` (maps the two
  hostnames to `:3000` / `:8787`).

### Gotchas

- **Single-level subdomains only.** Cloudflare free Universal SSL covers
  `risezome.app` and `*.risezome.app` (one level) but **not** a two-level
  name like `app.dev.risezome.app` — that fails the TLS handshake
  (`sslv3 alert handshake failure`). That's why the host is
  `dev.risezome.app`, not `app.dev.risezome.app`.
- **`allowedDevOrigins`.** Next dev blocks cross-origin `/_next` dev
  assets, so the tunnel host must be listed in
  `apps/portal/next.config.mjs` → `allowedDevOrigins` (currently
  `['192.168.68.93', 'dev.risezome.app']`) or the page renders but never
  hydrates (live demo + waitlist form dead). Editing this needs a portal
  restart.
- **`BOT_WORKER_BASE_URL`.** `apps/portal/.env.local` points at
  `wss://bot-worker-dev.risezome.app` so Recall dials the stable host.
  Restart the portal after changing it. (`BOT_WORKER_HTTP_URL` stays
  `http://localhost:8787` — that's a same-machine call.)

### One-off quick tunnel (fallback)

If the named tunnel is unavailable, a disposable tunnel still works but
gives a fresh random hostname each run (and you must re-paste it +
restart the portal):

```bash
cloudflared tunnel --url http://localhost:8787   # or :3000
```

See [`persistent-bot-worker-tunnel.md`](persistent-bot-worker-tunnel.md)
for the original named-tunnel background.

## Env-var checklist

The two `.env` files the dev servers read:

- `apps/portal/.env.local` — Supabase URL + service-role key,
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_APP_WEBHOOK_SECRET`,
  `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`, `RECALL_API_KEY`,
  `BOT_WORKER_BASE_URL`, `BOT_WORKER_SECRET`.
- `apps/bot-worker/.env` — `BOT_WORKER_SECRET` (must match the
  portal's), `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `DEEPGRAM_API_KEY` (for the
  `/local-debug` mic path), optional `GITHUB_TOKEN` +
  `UPWELL_GITHUB_REPO` (enables the live-API GitHub skills),
  optional `RISEZOME_KEY_TERMS_BOOST=true` (enables the rolling-
  summary `key_terms` embedding-query boost, default off).

Both files have `.env.example` siblings to copy from.

## Diagnosing a wedged process

Find what's holding the port:

```bash
ss -tlnp | grep -E ':3000|:8787|:8288'
```

Each row shows `users:(("<name>",pid=<pid>...))`. Kill the PID, then
restart the relevant terminal.

If `pnpm --filter ... dev` exits immediately with no error, check
that the `.env` file exists and isn't empty — `tsx --env-file=.env`
fails silently on a missing file.

## What is NOT running locally

- **Supabase** — by default the dev servers talk to the hosted Supabase
  project via the env-var URL/key. A local `supabase start` stack is now a
  first-class, switchable option, and `pnpm dev` is a one-command runner that
  wires env + starts everything per developer. For two developers sharing this
  repo without colliding, see
  [`two-developer-local-setup.md`](./two-developer-local-setup.md).
- **Recall.ai** — calls go to the hosted Recall API. The bot-worker
  serves the WebSocket the cloud bot dials back into.
- **Anthropic / Voyage / Deepgram** — all hosted; the dev servers
  use the same API keys production does (with smaller usage).
- **Daemon** (`apps/daemon`) — legacy desktop POC; not part of the
  shipping product. Don't start it unless you're actively working
  on the daemon.
