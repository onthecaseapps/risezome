#!/usr/bin/env bash
#
# Assemble the active local-dev env files from a developer's persistent
# secrets (.env.dev) + a Supabase mode (local|hosted) + tag-derived values.
#
#   scripts/use-env.sh [TAG] <local|hosted>
#
# TAG   developer tag (e.g. "nathan"). If omitted, read from .dev-tag, else
#       prompt and remember. It is the single isolation key — every per-dev
#       value (dev origin, bot-worker host) is derived from it.
# mode  local  → point Supabase at the local `supabase start` stack
#       hosted → use the dev's own hosted project creds from .env.dev
#
# Each developer fills ONE file per app once:
#   apps/portal/.env.dev      (cp from apps/portal/.env.example)
#   apps/bot-worker/.env.dev  (cp from apps/bot-worker/.env.example)
# This script writes the ACTIVE files the apps read:
#   apps/portal/.env.local    (Next.js auto-loads)
#   apps/bot-worker/.env      (tsx --env-file=.env)
#
# Secrets are never echoed to stdout (AGENTS.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTAL_DEV="$ROOT/apps/portal/.env.dev"
PORTAL_ACTIVE="$ROOT/apps/portal/.env.local"
BOT_DEV="$ROOT/apps/bot-worker/.env.dev"
BOT_ACTIVE="$ROOT/apps/bot-worker/.env"
TAG_FILE="$ROOT/.dev-tag"

# Well-known local `supabase start` keys (issuer "supabase-demo"). These are
# NOT secrets — they are identical on every machine — so baking them here is
# safe. The running stack's actual keys (via `supabase status -o env`) win when
# available, so this stays correct even if a future CLI changes them.
LOCAL_URL_FALLBACK="http://127.0.0.1:54321"
LOCAL_ANON_FALLBACK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"
LOCAL_SERVICE_FALLBACK="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UtZGVtbyIsImlhdCI6MTY0MTc2OTIwMCwiZXhwIjoxNzk5NTM1NjAwfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q"

usage() {
  echo "Usage: scripts/use-env.sh [TAG] <local|hosted>" >&2
  echo "  e.g. scripts/use-env.sh nathan local" >&2
}
die() { echo "use-env: $*" >&2; exit 1; }

# Upsert KEY=VALUE in a dotenv FILE (remove existing KEY= lines, append).
set_var() {
  local file=$1 key=$2 val=$3 tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$file"
}

# Parse args: accept "<mode>" or "<tag> <mode>".
TAG=""; MODE=""
case "$#" in
  1) MODE="$1" ;;
  2) TAG="$1"; MODE="$2" ;;
  *) usage; exit 2 ;;
esac
case "$MODE" in local|hosted) ;; *) usage; die "mode must be 'local' or 'hosted' (got '${MODE:-}')" ;; esac

# Resolve the tag: arg → .dev-tag → prompt (and remember).
if [ -z "$TAG" ]; then
  if [ -f "$TAG_FILE" ]; then
    TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  else
    printf 'Developer tag (e.g. nathan): ' >&2
    read -r TAG
  fi
fi
TAG="$(printf '%s' "$TAG" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
[ -n "$TAG" ] || die "empty developer tag"
printf '%s\n' "$TAG" > "$TAG_FILE"

# Validate the persistent dev files exist.
[ -f "$PORTAL_DEV" ] || die "missing $PORTAL_DEV — run: cp apps/portal/.env.example apps/portal/.env.dev and fill it in"
[ -f "$BOT_DEV" ]    || die "missing $BOT_DEV — run: cp apps/bot-worker/.env.example apps/bot-worker/.env.dev and fill it in"

# Start from the dev's persistent files.
cp "$PORTAL_DEV" "$PORTAL_ACTIVE"
cp "$BOT_DEV" "$BOT_ACTIVE"

# Supabase block: override with local-stack values, or keep the dev's hosted creds.
if [ "$MODE" = "local" ]; then
  L_URL="$LOCAL_URL_FALLBACK"; L_ANON="$LOCAL_ANON_FALLBACK"; L_SERVICE="$LOCAL_SERVICE_FALLBACK"
  # Prefer the running stack's real keys when reachable.
  if command -v supabase >/dev/null 2>&1; then
    if STATUS="$(cd "$ROOT" && supabase status -o env 2>/dev/null)"; then
      _v() { printf '%s' "$STATUS" | grep "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }
      [ -n "$(_v API_URL)" ] && L_URL="$(_v API_URL)"
      [ -n "$(_v ANON_KEY)" ] && L_ANON="$(_v ANON_KEY)"
      [ -n "$(_v SERVICE_ROLE_KEY)" ] && L_SERVICE="$(_v SERVICE_ROLE_KEY)"
    fi
  fi
  set_var "$PORTAL_ACTIVE" NEXT_PUBLIC_SUPABASE_URL "$L_URL"
  set_var "$PORTAL_ACTIVE" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$L_ANON"
  set_var "$PORTAL_ACTIVE" SUPABASE_SECRET_KEY "$L_SERVICE"
  set_var "$BOT_ACTIVE" SUPABASE_URL "$L_URL"
  set_var "$BOT_ACTIVE" SUPABASE_SECRET_KEY "$L_SERVICE"
fi

# Tag-derived per-dev hostnames (one-level subdomains — Universal SSL limit).
set_var "$PORTAL_ACTIVE" RISEZOME_DEV_ORIGIN "dev-${TAG}.risezome.app"
set_var "$PORTAL_ACTIVE" BOT_WORKER_BASE_URL "wss://bot-worker-dev-${TAG}.risezome.app"

echo "use-env: tag=${TAG} mode=${MODE} → wrote apps/portal/.env.local + apps/bot-worker/.env"
echo "use-env: restart the portal + bot-worker for changes to take effect."
