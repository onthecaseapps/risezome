# Persistent bot-worker tunnel (named Cloudflare tunnel)

Last updated: 2026-06-02

## Problem

Quick-mode `cloudflared tunnel --url http://localhost:8787` is fine for
one-off testing but:

- Generates a fresh `*.trycloudflare.com` hostname every session.
- That means re-pasting `BOT_WORKER_BASE_URL` into `apps/portal/.env.local`
  + restarting the portal every dev session.
- Recall.ai's dashboard webhook URL (if you've set one up to forward
  bot lifecycle events to the portal) also has to be re-updated.
- Cloudflare's free tier may drop idle WebSocket connections (~2 min
  with no traffic). Named tunnels via your own Cloudflare account
  have better behavior + named hostnames.

This runbook sets up a **named** cloudflared tunnel bound to a stable
hostname (`bot-worker.dev.risezome.app` or similar), so the
`BOT_WORKER_BASE_URL` stays the same across dev sessions.

## Prerequisites

- A Cloudflare account with the domain you want to use (e.g.
  `risezome.app`) added as a Zone. Free Cloudflare plan is fine.
- `cloudflared` CLI installed locally:
  ```bash
  brew install cloudflared   # or your distro's package manager
  cloudflared --version
  ```

## Steps

### 1. Authenticate

```bash
cloudflared tunnel login
```

This opens a browser; pick the Cloudflare zone for your domain
(`risezome.app`). The CLI writes a cert to `~/.cloudflared/cert.pem`.

### 2. Create a named tunnel

```bash
cloudflared tunnel create risezome-bot-worker-dev
```

Output looks like:

```
Tunnel credentials written to /Users/<you>/.cloudflared/<UUID>.json
Created tunnel risezome-bot-worker-dev with id <UUID>
```

Save the UUID. It's also retrievable via `cloudflared tunnel list`.

### 3. Route a DNS hostname through the tunnel

Pick a subdomain — e.g. `bot-worker.dev.risezome.app`:

```bash
cloudflared tunnel route dns risezome-bot-worker-dev bot-worker.dev.risezome.app
```

This creates a CNAME from `bot-worker.dev.risezome.app` →
`<UUID>.cfargotunnel.com` in your Cloudflare DNS. Verify in the
Cloudflare dashboard or via `dig CNAME bot-worker.dev.risezome.app`.

### 4. Create a config file

`~/.cloudflared/risezome-bot-worker-dev.yml`:

```yaml
tunnel: <UUID-from-step-2>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: bot-worker.dev.risezome.app
    service: http://localhost:8787
    # Important — WebSocket upgrade flows depend on no buffering
    originRequest:
      noTLSVerify: true
      disableChunkedEncoding: true
  - service: http_status:404
```

### 5. Run the tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/risezome-bot-worker-dev.yml run
```

Or as a brew service for persistence:

```bash
sudo cloudflared service install --config ~/.cloudflared/risezome-bot-worker-dev.yml
sudo brew services start cloudflared
```

### 6. Update `apps/portal/.env.local`

```env
BOT_WORKER_BASE_URL=wss://bot-worker.dev.risezome.app
BOT_WORKER_HTTP_URL=https://bot-worker.dev.risezome.app
```

Restart the portal dev server so the new env loads:

```bash
pnpm --filter @risezome/portal dev
```

### 7. Test

```bash
# HTTP probe
curl https://bot-worker.dev.risezome.app/health
# → {"ok":true,"runtimes":0}

# WebSocket upgrade should succeed too — toggle a bot on /upcoming.
```

## Sharing the tunnel between team members

A single named tunnel can be owned by one Cloudflare account. To let
multiple devs hit the same tunnel during a paired session:

- The tunnel owner runs `cloudflared tunnel ... run` on their machine
  with the bot-worker on `localhost:8787`.
- Other devs point `BOT_WORKER_BASE_URL` in their `.env.local` at the
  same hostname. Their bot-worker isn't reachable but the portal can
  still trigger meetings — Recall connects to the tunnel owner's
  machine.

For independent tunnels, create one named tunnel per developer
(`risezome-bot-worker-dev-nathan`, `risezome-bot-worker-dev-jordan`,
etc.) with unique subdomains.

## Removing the tunnel

```bash
# Stop the running tunnel
sudo brew services stop cloudflared

# Delete the named tunnel + its DNS route
cloudflared tunnel delete risezome-bot-worker-dev
# Remove the DNS CNAME manually from the Cloudflare dashboard
```

## Production note

Production uses a separate named tunnel pinned to `bot-worker.risezome.app`
(no `.dev`) → the Fly.io machine. That setup lives in
`apps/bot-worker/README.md` under the **Production — Fly.io** section.
Fly creates its own certs + DNS via `fly certs create`, but if you want
to keep the bot-worker behind Cloudflare for DDoS protection, the named
tunnel above with `service: http://<fly-internal-host>` is the pattern.
