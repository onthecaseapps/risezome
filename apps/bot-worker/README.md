# @risezome/bot-worker

Long-running Node service that accepts a Recall.ai realtime transcript
WebSocket per active meeting, adapts the wrapped transcript format into
the engine's `Utterance` shape, runs the engine pipeline (retrieval +
synthesis) against the org's pgvector corpus, persists cards / syntheses
/ gaps to Postgres, and broadcasts to Supabase Realtime.

## Pipeline

Per active meeting the service:

- Accepts the Recall.ai realtime WS at `/recall/:meetingId/:jwt` and
  verifies the JWT (HS256, signed with `BOT_WORKER_SECRET`, bound to the
  meeting).
- Adapts the Recall transcript format (`transcript.data` /
  `transcript.partial_data`) into the engine's `Utterance` shape and
  maintains a rolling transcript window + rolling summary per meeting.
- On each final utterance: embeds the window (Voyage), retrieves the top
  matches from the org's pgvector corpus, optionally routes the query to a
  skill (router classifier + skill registry), and synthesizes a cited
  answer (Claude) gated by the relevance classifier.
- Persists `meeting_events`, `cards`, and `syntheses` to Postgres and
  broadcasts the same events to Supabase Realtime on the meeting channel,
  which the portal's live page subscribes to.

The portal's Inngest launcher issues the JWT and tells Recall to connect
here. See [the architecture overview](../../README.md) for the end-to-end
flow.

## Local dev

```bash
pnpm --filter @risezome/bot-worker dev
```

Required env vars:

- `BOT_WORKER_SECRET` — HS256 secret for JWT signing. Generate with
  `openssl rand -base64 32`. Must match the launcher's secret.
- `BOT_WORKER_PORT` — defaults to `8787`.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — required, for DB writes +
  Realtime broadcast (service-role; server-only).
- `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY` — enable retrieval embeddings and
  synthesis/classification respectively.

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
