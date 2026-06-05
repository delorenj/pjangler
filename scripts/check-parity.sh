#!/usr/bin/env bash
# check-parity.sh — deterministic parity checker wrapper
# Usage: check-parity.sh [repo]
# Exits 0 when fully conformant, nonzero when gaps exist.
set -euo pipefail
REPO="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${PJANGLER_ENGINE:-${SCRIPT_DIR}/../src/index.ts}"
if [ ! -f "$ENGINE" ]; then
  echo "pjangler entrypoint not found: $ENGINE" >&2
  exit 1
fi
exec bun run "$ENGINE" audit "$REPO"
