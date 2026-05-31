# @risezome/bot-worker

Long-running Node service that accepts a Recall.ai realtime transcript
WebSocket per active meeting, adapts the wrapped transcript format into
the engine's `Utterance` shape, runs the engine pipeline (retrieval +
synthesis) against the org's pgvector corpus, persists cards / syntheses
/ gaps to Postgres, and broadcasts to Supabase Realtime.

## What's in U9c (this commit)

- HTTP server with WS upgrade at `/recall/:meetingId/:jwt`
- JWT verification (HS256, signed with `BOT_WORKER_SECRET`)
- Recall transcript adapter (`transcript.data` / `transcript.partial_data`
  → engine `Utterance`)
- In-memory per-meeting runtime (logs adapter output for now)

## What lands in U9d

- Engine pipeline wiring (RetrievalPipeline + MeetingSession +
  TranscriptWindow per meeting)
- Postgres-backed `TranscriptStore` + `CorpusReader`
- DB writes (cards, syntheses, gaps, meeting_events) before broadcast
- Supabase Realtime broadcast on `meeting:<orgId>:<meetingId>`
- JWT issuance in the portal's U8 launcher

## Local dev

```bash
pnpm --filter @risezome/bot-worker dev
```

Required env vars:

- `BOT_WORKER_SECRET` — HS256 secret for JWT signing. Generate with
  `openssl rand -base64 32`. Must match the launcher's secret.
- `BOT_WORKER_PORT` — defaults to `8787`.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — for DB writes (U9d).

To expose to a real Recall.ai bot during development, tunnel localhost:

```bash
cloudflared tunnel --url http://localhost:8787
# then in apps/portal/.env.local:
BOT_WORKER_BASE_URL=wss://<your-tunnel>.trycloudflare.com
```

The launcher includes that URL verbatim in
`recording_config.realtime_endpoints[0].url`. Recall forwards it to the
bot which connects back over wss.

## Production — Fly.io

Single machine in `iad` with `min_machines_running = 1` and
`auto_stop_machines = false`. Recall connects inbound over WSS at
`/recall/:meetingId/:jwt`. Single-machine means rolling deploys briefly
interrupt active WS sessions; "do not deploy during active meetings"
policy applies until multi-instance + sticky routing lands.

### One-time setup

```bash
# Install the Fly CLI (one-time)
brew install flyctl
fly auth login

# Create the app (one-time, run from the repo root)
fly apps create risezome-bot-worker --org <your-fly-org>

# Set secrets (one-time + on rotation)
fly secrets set --app risezome-bot-worker \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SECRET_KEY=sb_secret_... \
  BOT_WORKER_SECRET=<same as portal's> \
  VOYAGE_API_KEY=... \
  ANTHROPIC_API_KEY=sk-ant-...

# Map your domain to the app (one-time)
fly certs create bot-worker.risezome.app --app risezome-bot-worker
# then add the CNAME from `fly certs show` to your DNS provider
```

### Deploy

```bash
# From the monorepo root (NOT apps/bot-worker/) so the Docker build
# context can see workspace files
fly deploy --config apps/bot-worker/fly.toml --dockerfile apps/bot-worker/Dockerfile
```

Update portal env after first deploy:

```env
# apps/portal/.env.local (or Vercel project env)
BOT_WORKER_BASE_URL=wss://bot-worker.risezome.app
BOT_WORKER_HTTP_URL=https://bot-worker.risezome.app
```

### Healthcheck

`fly status` shows the machine state. `GET /health` returns `{ok: true,
runtimes: N}` where `runtimes` is the count of active per-meeting
runtimes. If runtimes is unexpectedly high (>10) after meetings should
have ended, something's leaking state.
