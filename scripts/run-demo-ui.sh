#!/usr/bin/env bash
set -euo pipefail

# Parse help/invalid arguments in Python before selecting tools or doing work.
command -v python3 >/dev/null || { echo 'ERROR: Python 3 is required.' >&2; exit 1; }
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/run-demo-ui.py" "$@"
