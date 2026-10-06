#!/usr/bin/env bash
set -euo pipefail

# Reject arguments before selecting tools, building artifacts or starting runners.
if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
    cat <<'HELP'
Usage: bash scripts/run-demo.sh [--help]

Build existing artifacts, then run Filled and Cancelled recovery sequentially
on separate fresh local deployments. Print validated public evidence in base
units (six token decimals). Logs and demo-summary.json stay in .runtime/demo-*.
Requires the installed pinned tools, harness dependencies, and Linux namespace
permissions. No tools are installed. Failure or interruption exits unsuccessfully;
the active scenario runner owns node cleanup. No other arguments are supported.
HELP
    exit 0
  fi
  echo 'ERROR: Unsupported arguments. Use bash scripts/run-demo.sh --help.' >&2
  exit 2
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
# The documented existing Foundry installation may not be on the caller's PATH.
export PATH="$PATH:$HOME/.foundry/bin"
command -v python3 >/dev/null || { echo 'ERROR: Python 3 is required.' >&2; exit 1; }
exec python3 "$LAB_ROOT/scripts/run-demo.py"
