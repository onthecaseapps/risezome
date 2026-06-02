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
- On each final utterance (after a cadence gate): embeds the window
  (Voyage) and runs the multi-stage retrieval pipeline — hybrid search
  (vector + FTS → RRF), optional rerank (Voyage rerank-2.5), CRAG on-miss
  expansion, and parent-document expansion — optionally routes the query
  to a self-healing skill (router classifier + skill registry, with a
  safety-net that drops an unverifiable result back to RAG), gates for
  relevance, and synthesizes a cited answer (Claude) under a
  grounded-or-nothing rule with citation verification.
- Persists `meeting_events`, `cards`, and `syntheses` to Postgres and
  broadcasts the same events to Supabase Realtime on the meeting channel,
  which the portal's live page subscribes to.

The orchestration entry point is `src/retrieval.ts`. **For the full,
current-state description of every stage, gate, threshold, and feature
flag, see the canonical
[`docs/architecture/retrieval-pipeline.md`](../../docs/architecture/retrieval-pipeline.md)**
(this section is intentionally a summary so it doesn't drift). The portal's
Inngest launcher issues the JWT and tells Recall to connect here.

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

Optional pipeline feature flags (see the
[pipeline doc](../../docs/architecture/retrieval-pipeline.md#6-feature-flags)
for full semantics). All default off/neutral in code; set them to enable a
stage:

- `RISEZOME_RERANK_ENABLED` — Voyage rerank-2.5 after RRF (needs `VOYAGE_API_KEY`).
- `RISEZOME_PARENT_DOC_ENABLED` — parent-document expansion; tune with
  `RISEZOME_PARENT_DOC_CAP_CHARS` (default 6000) and
  `RISEZOME_PARENT_DOC_WINDOW` (default 1).
- `RISEZOME_CRAG_ENABLED` — CRAG query expansion on a miss **or** a
  low-confidence first pass (needs `ANTHROPIC_API_KEY`);
  `RISEZOME_CRAG_STRONG_DISTANCE` (default 0.30) sets the low-confidence cutoff.
- `RISEZOME_VECTOR_DISTANCE_FLOOR` — vector relevance floor in RRF (default 0.45).
- `RISEZOME_KEY_TERMS_BOOST` — append rolling-summary key terms to the embedding query.
- `TRELLO_API_KEY` — enables the live Trello skills.

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
