#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd "$LAB_ROOT"
python3 - <<'PY'
from pathlib import Path
import shutil
import subprocess

expected = {
    "rustup": "rustup 1.28.2",
    "rustc": "rustc 1.99.0",
    "cargo": "cargo 1.99.0",
    "avm": "avm 1.2.0",
    "anchor": "anchor-cli 1.2.0",
    "solana": "solana-cli 4.1.2",
    "solana-test-validator": "solana-test-validator 4.1.2",
    "cargo-build-sbf": "cargo-build-sbf 4.1.0",
    "forge": "forge Version: 1.5.1-stable",
    "cast": "cast Version: 1.5.1-stable",
    "anvil": "anvil Version: 1.5.1-stable",
    "node": "v24.21.0",
    "npm": "11.19.0",
}
for tool, version in expected.items():
    executable = shutil.which(tool)
    assert executable, f"Missing executable: {tool}"
    resolved = Path(executable).resolve()
    assert not str(resolved).startswith("/mnt/"), f"Windows executable: {resolved}"
    if tool != "npm":
        with resolved.open("rb") as binary:
            assert binary.read(4) == b"\x7fELF", f"Not native Linux ELF: {resolved}"
    actual = subprocess.check_output([executable, "--version"], text=True, stderr=subprocess.STDOUT)
    assert any(line == version or line.startswith(version + " ") for line in actual.splitlines()), actual
    print(f"PASS: {version} — {executable}")
solc = Path(".local/solc-0.8.30").resolve()
actual = subprocess.check_output([str(solc), "--version"], text=True)
assert "0.8.30+commit.73712a01.Linux.g++" in actual
print(f"PASS: Solidity 0.8.30+commit.73712a01 — {solc}")
PY
