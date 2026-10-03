#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
mkdir -p "$LAB_ROOT/.local/logs" "$LAB_ROOT/.runtime"

if [[ ! -f "$LAB_ROOT/.runtime/build-wallet.json" ]]; then
  solana-keygen new --silent --no-bip39-passphrase \
    --outfile "$LAB_ROOT/.runtime/build-wallet.json" >/dev/null
fi

(
  cd "$LAB_ROOT/evm"
  forge build --use "$LAB_ROOT/.local/solc-0.8.30"
  forge fmt --check
) 2>&1 | tee "$LAB_ROOT/.local/logs/forge-build.log"

(
  cd "$LAB_ROOT/solana"
  cargo check --workspace --locked
  cargo fmt --all -- --check
  lock_hash="$(sha256sum Cargo.lock)"
  # Anchor forwards extra Cargo arguments to both SBF and IDL test runners.
  # Check the lock before building and require it to remain byte-for-byte stable.
  anchor build --ignore-keys --tools-version v1.54 --arch v0
  [[ "$(sha256sum Cargo.lock)" == "$lock_hash" ]]
  python3 - <<'PY'
import json
from pathlib import Path
idl = json.loads(Path("target/idl/settlement_lab.json").read_text())
assert [instruction["name"] for instruction in idl["instructions"]] == ["initialize"]
assert Path("target/deploy/settlement_lab.so").stat().st_size > 0
assert Path("target/types/settlement_lab.ts").is_file()
print("PASS: SBF binary, JSON IDL, and TypeScript IDL; exactly initialize")
PY
) 2>&1 | tee "$LAB_ROOT/.local/logs/anchor-build.log"

(
  cd "$LAB_ROOT/harness"
  npm run typecheck
  npm run check:imports
) 2>&1 | tee "$LAB_ROOT/.local/logs/typescript-check.log"
