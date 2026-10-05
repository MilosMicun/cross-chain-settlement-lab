#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
exec python3 "$LAB_ROOT/scripts/check-solana-deployment.py" "$@"
