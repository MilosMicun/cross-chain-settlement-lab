#!/usr/bin/env bash
# Source this file to select the isolated native Linux tools for this checkout.
LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export LAB_ROOT
export CARGO_HOME="$LAB_ROOT/.local/cargo"
export RUSTUP_HOME="$LAB_ROOT/.local/rustup"
export AVM_HOME="$LAB_ROOT/.local/avm"
export XDG_CACHE_HOME="$LAB_ROOT/.local/cache"
export npm_config_cache="$LAB_ROOT/.local/npm-cache"
export CARGO_BUILD_JOBS=2
export PATH="$LAB_ROOT/.local/bin:$LAB_ROOT/.local/node-v24.21.0-linux-x64/bin:$AVM_HOME/bin:$CARGO_HOME/bin:$LAB_ROOT/.local/solana-4.1.2/bin:$PATH"
