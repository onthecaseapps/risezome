#!/usr/bin/env bash
#
# Print the SHA-256 of the built macOS sidecar binary. The bot-worker's
# local-debug handler hashes the binary on the fly before spawning it, so a
# manifest entry is not required for the debug page — but the daemon's
# production manifest (apps/daemon/src/audio/ipc/manifest.ts) compares this
# value at launch and refuses to spawn a binary that doesn't match.
#
# Usage: ./scripts/compute-sha256.sh [path]
#
# Default path: ./build/risezome-sidecar-macos
set -euo pipefail

bin=${1:-build/risezome-sidecar-macos}

if [[ ! -f "$bin" ]]; then
  echo "Binary not found at: $bin"
  echo "Build with 'make' first."
  exit 1
fi

sha=$(shasum -a 256 "$bin" | awk '{print $1}')
echo "$sha  $bin"
echo ""
echo "If wiring into the daemon's production manifest:"
echo "  '$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")': { sha256: '$sha' },"
