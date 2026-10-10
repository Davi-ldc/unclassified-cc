#!/usr/bin/env bash
# Generate Docker configuration. The published gateway port stays on host loopback.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$ROOT"
bun src/scripts/setup.ts init --docker --directory "$ROOT" "$@"

if [[ -z "${CC_GATEWAY_UPSTREAM_API_KEY:-}" ]]; then
  printf '%s\n' 'Configuration created. Set CC_GATEWAY_UPSTREAM_API_KEY in the server environment, then run:' 'CC_GATEWAY_UID="$(id -u)" CC_GATEWAY_GID="$(id -g)" docker compose up --build -d'
  exit 0
fi

export CC_GATEWAY_UID="$(id -u)"
export CC_GATEWAY_GID="$(id -g)"
exec docker compose up --build -d
