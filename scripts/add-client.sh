#!/usr/bin/env bash
# Usage: bash scripts/add-client.sh <client-name> [gateway-url]
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$ROOT"
exec bun src/scripts/setup.ts add-client --directory "$ROOT" "$@"
