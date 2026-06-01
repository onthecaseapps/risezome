# Local dev processes

Last updated: 2026-05-31

The cloud app needs three long-running processes to function locally.
Each in its own terminal; cleanup is `Ctrl-C` per terminal. Run from
the repo root unless noted.

## The three processes

| # | Process | Command | Port | Notes |
|---|---------|---------|------|-------|
| 1 | **Portal** (Next.js) | `pnpm --filter @risezome/portal dev` | `:3000` | Web app + Inngest endpoint at `/api/inngest`. Needs `apps/portal/.env.local`. |
| 2 | **Inngest dev CLI** | `npx inngest-cli@latest dev` | `:8288` | Auto-discovers functions from the portal endpoint. Dashboard at `http://localhost:8288`. Start **after** the portal so discovery succeeds on first poll. |
| 3 | **Bot-worker** (Fastify) | `pnpm --filter @risezome/bot-worker dev` | `:8787` | Long-lived WS server for the Recall.ai bot. Needs `apps/bot-worker/.env`. |

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

## Optional: real Recall.ai bot

The three processes above are enough for portal browsing, Inngest
function dev (calendar sync, repo + issues indexers), and the
bot-worker's `/local-debug` mic surface. A **real Recall.ai bot**
connecting back to your laptop additionally needs a public hostname
pointing at `:8787`:

- One-off: `cloudflared tunnel --url http://localhost:8787` and paste
  the generated hostname into `apps/portal/.env.local` as
  `BOT_WORKER_BASE_URL`, then restart the portal.
- Named/stable: see [`persistent-bot-worker-tunnel.md`](persistent-bot-worker-tunnel.md).

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

- **Supabase** — the dev servers talk to the hosted Supabase project
  via the env-var URL/key. There's no local Postgres or
  `supabase start` in this setup.
- **Recall.ai** — calls go to the hosted Recall API. The bot-worker
  serves the WebSocket the cloud bot dials back into.
- **Anthropic / Voyage / Deepgram** — all hosted; the dev servers
  use the same API keys production does (with smaller usage).
- **Daemon** (`apps/daemon`) — legacy desktop POC; not part of the
  shipping product. Don't start it unless you're actively working
  on the daemon.
