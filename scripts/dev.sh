#!/usr/bin/env bash
#
# One-command local dev. Resolves your developer tag, wires the env, brings up
# all components, and streams their logs into one prefixed view.
#
#   pnpm dev [TAG] [local|hosted] [--no-supabase] [--tunnel] [--dry-run]
#
#   TAG            developer tag (default: remembered in .dev-tag, else prompt)
#   local|hosted   Supabase target (default: local)
#   --no-supabase  don't start/seed the local Supabase stack (use one you manage)
#   --tunnel       also run your per-dev cloudflared tunnel
#   --dry-run      print the plan and exit (no processes started)
#
# In local mode it brings the Supabase stack up if it isn't already, and runs
# `supabase db reset` (migrations + seed) ONLY when it had to start the stack
# fresh — it never resets a stack you're already using. Ctrl-C tears every
# process down together (concurrently --kill-others).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG_FILE="$ROOT/.dev-tag"

MODE="local"; TAG=""; NO_SUPABASE=0; TUNNEL=0; DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    local|hosted) MODE="$arg" ;;
    --no-supabase) NO_SUPABASE=1 ;;
    --tunnel) TUNNEL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TAG="$arg" ;;
  esac
done

# Resolve tag (arg → .dev-tag → prompt), mirroring use-env.sh.
if [ -z "$TAG" ]; then
  if [ -f "$TAG_FILE" ]; then TAG="$(tr -d '[:space:]' < "$TAG_FILE")"; else
    printf 'Developer tag (e.g. nathan): ' >&2; read -r TAG
  fi
fi
TAG="$(printf '%s' "$TAG" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
[ -n "$TAG" ] || { echo "dev: empty developer tag" >&2; exit 1; }

TUNNEL_CONFIG="${HOME}/.cloudflared/risezome-dev-${TAG}.yml"
START_SUPABASE=0
if [ "$MODE" = "local" ] && [ "$NO_SUPABASE" -eq 0 ]; then START_SUPABASE=1; fi

# U13: the tunnel publishes localhost:3000/8787 to the public internet; in hosted
# mode those are backed by a real database. Refuse unless explicitly acknowledged.
if [ "$TUNNEL" -eq 1 ] && [ "$MODE" = "hosted" ] && [ "${RISEZOME_TUNNEL_HOSTED_OK:-}" != "1" ]; then
  echo "dev: refusing the tunnel in hosted mode — it would expose a real-data stack to the internet." >&2
  echo "dev: use local mode, or set RISEZOME_TUNNEL_HOSTED_OK=1 to override (consider Cloudflare Access)." >&2
  TUNNEL=0
fi

# Build the concurrently process list.
NAMES="portal,inngest,bot"
COLORS="blue,magenta,green"
CMDS=(
  "pnpm --filter @risezome/portal dev"
  "npx inngest-cli@latest dev"
  "pnpm --filter @risezome/bot-worker dev"
)
if [ "$DRY_RUN" -eq 1 ]; then
  echo "plan: tag=${TAG} mode=${MODE}"
  echo "step: env (scripts/use-env.sh ${TAG} ${MODE})"
  [ "$START_SUPABASE" -eq 1 ] && echo "step: supabase-up (start-if-needed + reset-if-fresh)"
  echo "proc: portal"
  echo "proc: inngest"
  echo "proc: bot"
  [ "$TUNNEL" -eq 1 ] && echo "proc: tunnel (${TUNNEL_CONFIG})"
  exit 0
fi

# 1. Wire env for this tag + mode.
bash "$ROOT/scripts/use-env.sh" "$TAG" "$MODE"

# 2. Bring up the local Supabase stack (only resets when freshly started).
if [ "$START_SUPABASE" -eq 1 ]; then
  if ! command -v supabase >/dev/null 2>&1; then
    echo "dev: supabase CLI not found — install it or pass --no-supabase" >&2; exit 1
  fi
  # supabase/config.toml wires the Google auth provider via env(...) — export
  # those vars (from the generated portal env) so `supabase start` configures
  # local Google sign-in. Without this the local provider gets an empty client.
  for _k in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET; do
    _v="$(grep "^${_k}=" "$ROOT/apps/portal/.env.local" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    [ -n "$_v" ] && export "${_k}=${_v}"
  done
  if (cd "$ROOT" && supabase status >/dev/null 2>&1); then
    echo "dev: local Supabase already running — leaving it (not resetting your data)."
  else
    echo "dev: starting local Supabase stack…"
    (cd "$ROOT" && supabase start)
    echo "dev: applying migrations + seed (supabase db reset)…"
    (cd "$ROOT" && supabase db reset)
  fi
fi

# 2b. Ensure the per-dev cloudflared tunnel exists (create it if missing), then
#     add it to the launch set — but only if setup succeeded, so a missing/
#     unauthenticated cloudflared doesn't take down the whole stack via
#     --kill-others.
if [ "$TUNNEL" -eq 1 ]; then
  echo "dev: ensuring cloudflared tunnel for ${TAG}…"
  if bash "$ROOT/scripts/ensure-tunnel.sh" "$TAG"; then
    NAMES="${NAMES},tunnel"; COLORS="${COLORS},yellow"
    CMDS+=("cloudflared tunnel --config ${TUNNEL_CONFIG} run")
  else
    echo "dev: warning — tunnel setup failed (see above); launching without the tunnel." >&2
  fi
fi

# 3. Launch everything with one multiplexed, prefixed log stream. --kill-others
#    so Ctrl-C (or any process dying) tears the whole stack down together.
echo "dev: launching portal + inngest + bot-worker${TUNNEL:+ + tunnel}…"
exec npx concurrently \
  --kill-others \
  --names "$NAMES" \
  --prefix-colors "$COLORS" \
  "${CMDS[@]}"
