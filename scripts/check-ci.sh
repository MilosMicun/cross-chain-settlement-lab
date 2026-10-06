#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  echo 'Usage: bash scripts/check-ci.sh (no arguments)' >&2
  exit 2
fi
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd "$LAB_ROOT"
mkdir -p .runtime
ci_runtime="$(mktemp -d "$LAB_ROOT/.runtime/ci-XXXXXXXX")"
reports="$ci_runtime/reports"
mkdir -p "$reports"
touch "$ci_runtime/started"
echo "CI public reports: ${reports#"$LAB_ROOT/"}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'report-path=%s\n' "${reports#"$LAB_ROOT/"}" >> "$GITHUB_OUTPUT"
fi

# Copy only named public records produced during this invocation, never runtime
# fixtures, keypairs, tools, caches, target trees, or environment dumps.
collect_reports() {
  python3 - "$LAB_ROOT" "$ci_runtime" "$1" <<'PY'
import json
from pathlib import Path
import re
import shutil
import sys

root, runtime = map(Path, sys.argv[1:3])
reports = runtime / "reports"
started = (runtime / "started").stat().st_mtime_ns
(reports / "ci-summary.json").write_text(json.dumps({
    "exitCode": int(sys.argv[3]), "regressionMode": "offline",
    "requiredStageCount": 17,
}, indent=2) + "\n")

def copy(source, destination):
    if source.is_file() and not source.is_symlink() and source.stat().st_mtime_ns >= started:
        destination.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, destination)

for name in ("forge-build.log", "anchor-build.log", "typescript-check.log"):
    copy(root / ".local/logs" / name, reports / "build" / name)
for name in ("rust-install.log", "avm-install.log", "anchor-install.log", "sbf-tools-install.log"):
    copy(root / ".local/logs" / name, reports / "install" / name)
log = reports / "regression.log"
if log.is_file():
    matches = re.findall(r"^Regression mode: offline; logs/summary: (\.runtime/regression-[A-Za-z0-9_-]+)$",
                         log.read_text(), re.MULTILINE)
    if len(matches) != 1:
        raise ValueError("Expected exactly one current offline regression announcement")
    regression = root / matches[0]
    if regression.is_symlink() or regression.resolve() != regression:
        raise ValueError("Invalid regression report directory")
    summary = regression / "regression-summary.json"
    copy(summary, reports / summary.name)
    data = json.loads(summary.read_text())
    if data["mode"] != "offline" or len(data["requiredStages"]) != 17:
        raise ValueError("Expected the unchanged 17-stage offline regression")
    for name in data["requiredStages"]:
        if not re.fullmatch(r"[a-z-]+", name):
            raise ValueError("Invalid stage log name")
        copy(regression / f"{name}.log", reports / "stages" / f"{name}.log")
PY
}

finish() {
  local command_status=$? collection_status=0
  trap - EXIT
  collect_reports "$command_status" || collection_status=$?
  echo "CI exit status: $command_status; report collection status: $collection_status"
  echo "CI public reports: ${reports#"$LAB_ROOT/"}"
  # Collection must never hide the failing setup/regression command's status.
  if (( command_status != 0 )); then
    exit "$command_status"
  fi
  exit "$collection_status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

logged() {
  local log="$1"
  shift
  local -a statuses
  if "$@" 2>&1 | tee "$reports/$log"; then
    return 0
  else
    statuses=("${PIPESTATUS[@]}")
    if (( statuses[0] != 0 )); then
      return "${statuses[0]}"
    fi
    return "${statuses[1]}"
  fi
}

setup() {
  [[ "$(uname -sm)" == 'Linux x86_64' ]] || {
    echo 'ERROR: CI setup requires native x86_64 Linux.' >&2
    return 1
  }
  local available_kib minimum_kib=$((12 * 1024 * 1024))
  available_kib="$(df -Pk "$LAB_ROOT" | awk 'NR == 2 {print $4}')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || return 1
  echo "Repository disk available: $available_kib KiB; minimum: $minimum_kib KiB (12 GiB)."
  # Conservative admission check, not a guarantee against later disk exhaustion.
  if (( available_kib < minimum_kib )); then
    echo 'ERROR: Insufficient installation/build space; no unrelated files will be deleted.' >&2
    return 1
  fi

  local tool version missing=0
  for tool in forge cast anvil; do
    if command -v "$tool" >/dev/null; then
      version="$("$tool" --version)"
      if [[ "${version%%$'\n'*}" != "$tool Version: 1.5.1-stable" ]]; then
        echo "ERROR: Selected $tool must be exactly Foundry 1.5.1; refusing an upgrade." >&2
        return 1
      fi
    else
      missing=1
    fi
  done
  if (( missing )); then
    local archive="$LAB_ROOT/.local/downloads/foundry-1.5.1-stable-linux-amd64.tar.gz"
    # Official stable release asset 331712097 is exactly 1.5.1-stable, commit
    # b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2. Pin the asset ID and digest,
    # not the moving stable download URL. Metadata/checksum verified at:
    # https://api.github.com/repos/foundry-rs/foundry/releases/assets/331712097
    # The v1.5.1-tagged archive reports 1.5.1-v1.5.1 instead of the existing pin.
    local digest=9cb14a30fa95c1af1cbeb035272baec0e85298dc18e6a45ca7236eca5ce95474
    mkdir -p .local/downloads .local/foundry-1.5.1/bin
    if [[ ! -f "$archive" ]] || ! printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status; then
      curl --fail --silent --show-error --location --connect-timeout 10 --max-time 300 \
        --header 'Accept: application/octet-stream' \
        https://api.github.com/repos/foundry-rs/foundry/releases/assets/331712097 \
        --output "$archive.part"
      printf '%s  %s\n' "$digest" "$archive.part" | sha256sum --check
      mv "$archive.part" "$archive"
    fi
    printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
    tar -xzf "$archive" -C .local/foundry-1.5.1/bin forge cast anvil
    hash -r
  fi
  bash scripts/install-tools.sh
}

# Match the existing regression wrapper's selection, including ~/.foundry/bin.
export PATH="$HOME/.foundry/bin:$LAB_ROOT/.local/foundry-1.5.1/bin:$PATH"
# A separate strict shell keeps errexit active inside setup even though logged
# uses a conditional pipeline to retain the original command's exit status.
logged setup.log bash -euo pipefail -c "$(declare -f setup); setup"
# The installer and this explicit check verify native binaries and every pin.
logged versions.log bash scripts/check-tools.sh
logged npm-ci.log bash -euo pipefail -c 'cd "$LAB_ROOT/harness"; npm ci --ignore-scripts --no-audit'
logged regression.log bash scripts/check-regression.sh --offline
