#!/usr/bin/env bash
set -euo pipefail

# Validate before selecting tools, creating runtime output, or running checks.
case "$#:${1-}" in
  0:|1:--offline) ;;
  1:--help|1:-h)
    cat <<'HELP'
Usage: bash scripts/check-regression.sh [--offline | --help]

Default: run builds, static checks, Rust/Forge/offline TypeScript tests, then
all selected live wrappers sequentially on disposable local fixtures.
--offline: run only checks that require no local RPC nodes or live runners.

Requires installed pinned tools and harness dependencies; full mode also needs
Linux user/network namespace permissions and free runner-reserved ports.
No automatic installation or upgrades. Stage logs and regression-summary.json
stay in a new ignored .runtime/regression-* directory. The first failure,
interruption, or deadline stops the run; the active runner owns node cleanup.
HELP
    exit 0
    ;;
  *)
    echo 'ERROR: Invalid or conflicting arguments. Use bash scripts/check-regression.sh --help.' >&2
    exit 2
    ;;
esac

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
# Select the documented native Foundry installation, then verify its pins.
export PATH="$HOME/.foundry/bin:$PATH"
command -v python3 >/dev/null || { echo 'ERROR: Python 3 is required.' >&2; exit 1; }
exec python3 "$LAB_ROOT/scripts/check-regression.py" "$@"
