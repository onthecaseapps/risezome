#!/usr/bin/env bash
# Ensure a persistent per-developer cloudflared named tunnel exists and is
# configured, creating whatever is missing. Idempotent — safe to run on every
# startup. Streams progress to stdout.
#
# Each developer gets their own named tunnel `risezome-dev-<tag>` with one-level
# subdomains (Cloudflare Universal SSL only covers one level):
#   dev-<tag>.risezome.app             → http://localhost:3000  (portal)
#   bot-worker-dev-<tag>.risezome.app  → http://localhost:8787  (bot-worker WS)
#
# Exit codes:
#   0  ready (created or already present)
#   2  usage error (no tag)
#   3  cloudflared not installed
#   4  cloudflared not authenticated (no ~/.cloudflared/cert.pem)
#   5  tunnel create / route / config failure
#
# Test seams (env overrides): CLOUDFLARED_BIN (default "cloudflared"),
# CF_DIR (default "$HOME/.cloudflared").
set -uo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: ensure-tunnel.sh <tag>" >&2
  exit 2
fi

CF="${CLOUDFLARED_BIN:-cloudflared}"
CF_DIR="${CF_DIR:-$HOME/.cloudflared}"
NAME="risezome-dev-${TAG}"
CONFIG="${CF_DIR}/${NAME}.yml"
PORTAL_HOST="dev-${TAG}.risezome.app"
WORKER_HOST="bot-worker-dev-${TAG}.risezome.app"

if ! command -v "$CF" >/dev/null 2>&1; then
  echo "[tunnel] cloudflared is not installed." >&2
  echo "[tunnel] install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 3
fi

if [ ! -f "${CF_DIR}/cert.pem" ]; then
  echo "[tunnel] cloudflared is not authenticated." >&2
  echo "[tunnel] run this once (opens a browser to pick the risezome.app zone): cloudflared tunnel login" >&2
  exit 4
fi

# Resolve a tunnel's id by name from `tunnel list` JSON (empty if not found).
tunnel_id() {
  "$CF" tunnel list --output json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in data or []:
    if t.get('name') == '${NAME}':
        print(t.get('id', ''))
        break
" 2>/dev/null
}

UUID="$(tunnel_id)"
if [ -z "$UUID" ]; then
  echo "[tunnel] creating persistent tunnel ${NAME}…"
  if ! "$CF" tunnel create "${NAME}"; then
    echo "[tunnel] failed to create tunnel ${NAME}" >&2
    exit 5
  fi
  UUID="$(tunnel_id)"
fi
if [ -z "$UUID" ]; then
  echo "[tunnel] could not resolve tunnel id for ${NAME}" >&2
  exit 5
fi

CRED="${CF_DIR}/${UUID}.json"
if [ ! -f "$CRED" ]; then
  echo "[tunnel] warning: credentials file $CRED is missing — the tunnel was likely created on another machine. Run 'cloudflared tunnel delete ${NAME}' and start again to recreate it here." >&2
fi

# Route both hostnames through the tunnel (idempotent — "already exists" is fine).
echo "[tunnel] routing ${PORTAL_HOST} and ${WORKER_HOST}…"
"$CF" tunnel route dns "${NAME}" "${PORTAL_HOST}" 2>&1 | grep -viE 'already|record with that host' || true
"$CF" tunnel route dns "${NAME}" "${WORKER_HOST}" 2>&1 | grep -viE 'already|record with that host' || true

# Write the ingress config (idempotent overwrite). The bot-worker host needs the
# WebSocket-friendly originRequest settings (per persistent-bot-worker-tunnel.md).
mkdir -p "${CF_DIR}"
cat > "${CONFIG}" <<YAML
tunnel: ${UUID}
credentials-file: ${CRED}

ingress:
  - hostname: ${PORTAL_HOST}
    service: http://localhost:3000
  - hostname: ${WORKER_HOST}
    service: http://localhost:8787
    originRequest:
      noTLSVerify: true
      disableChunkedEncoding: true
  - service: http_status:404
YAML

echo "[tunnel] ready: ${NAME}"
echo "[tunnel]   ${PORTAL_HOST} → :3000"
echo "[tunnel]   ${WORKER_HOST} → :8787"
echo "[tunnel] config: ${CONFIG}"
