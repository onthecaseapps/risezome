#!/usr/bin/env bash
#
# Print the SHA-256 of the built sidecar binary. The daemon's
# integrity manifest (apps/daemon/src/audio/ipc/manifest.ts in
# production) compares this value at launch and refuses to spawn
# a binary that doesn't match.
#
# Usage: ./scripts/compute-sha256.sh [path]
#
# Default path: ./build/risezome-sidecar-linux
set -euo pipefail

bin=${1:-build/risezome-sidecar-linux}

if [[ ! -f "$bin" ]]; then
  echo "Binary not found at: $bin"
  echo "Build with 'make' first."
  exit 1
fi

sha=$(sha256sum "$bin" | awk '{print $1}')
echo "$sha  $bin"
echo ""
echo "Add to apps/daemon/src/audio/ipc/manifest.ts production manifest:"
echo "  '$(realpath "$bin")': { sha256: '$sha' },"
