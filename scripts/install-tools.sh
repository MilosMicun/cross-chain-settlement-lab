#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd "$LAB_ROOT"
mkdir -p .local/downloads .local/logs .local/bin

fetch() {
  local url="$1" destination="$2" digest="$3"
  if [[ -f "$destination" ]] && printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status; then
    return
  fi
  curl --fail --silent --show-error --location --connect-timeout 10 \
    --max-time 300 "$url" --output "$destination.part"
  printf '%s  %s\n' "$digest" "$destination.part" | sha256sum --check --status
  mv "$destination.part" "$destination"
}

if [[ ! -x .local/node-v24.21.0-linux-x64/bin/node ]]; then
  fetch https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
    .local/downloads/node-v24.21.0-linux-x64.tar.xz \
    fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
  tar -xJf .local/downloads/node-v24.21.0-linux-x64.tar.xz -C .local
fi

if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  fetch https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init \
    .local/downloads/rustup-init \
    20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
  chmod +x .local/downloads/rustup-init
  .local/downloads/rustup-init -y --no-modify-path --profile minimal \
    --default-toolchain 1.99.0 --component rustfmt > .local/logs/rust-install.log 2>&1
fi
if ! rustup run 1.99.0 rustc --version >/dev/null 2>&1; then
  rustup toolchain install 1.99.0 --profile minimal --component rustfmt
fi

if [[ ! -x .local/solana-4.1.2/bin/solana ]]; then
  fetch https://github.com/anza-xyz/agave/releases/download/v4.1.2/solana-release-x86_64-unknown-linux-gnu.tar.bz2 \
    .local/downloads/solana-4.1.2.tar.bz2 \
    5991d027a686eb419a709a479178b33eb83501e8a2bfbf599a81a286bfcbf770
  mkdir -p .local/solana-4.1.2
  tar -xjf .local/downloads/solana-4.1.2.tar.bz2 --strip-components=1 -C .local/solana-4.1.2
fi

if [[ ! -x "$CARGO_HOME/bin/avm" ]]; then
  fetch https://api.github.com/repos/otter-sec/anchor/tarball/v1.2.0 \
    .local/downloads/anchor-1.2.0.tar.gz \
    845c00fc79b5ddf3dbd6e9baca046ee26bed80673f896a9919a0fb586ad4aef7
  mkdir -p .local/anchor-source
  tar -xzf .local/downloads/anchor-1.2.0.tar.gz --strip-components=1 -C .local/anchor-source
  cargo install --path .local/anchor-source/avm --locked > .local/logs/avm-install.log 2>&1
fi
if [[ ! -x "$AVM_HOME/bin/anchor-1.2.0" ]]; then
  avm install 1.2.0 > .local/logs/anchor-install.log 2>&1
fi
# Select the installed official binary; the AVM proxy has a stale Solana catalog.
ln -sfn ../avm/bin/anchor-1.2.0 .local/bin/anchor

if [[ ! -x .local/solc-0.8.30 ]]; then
  fetch https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.30+commit.73712a01 \
    .local/solc-0.8.30 \
    f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7
  chmod +x .local/solc-0.8.30
fi

if [[ ! -x "$HOME/.cache/solana/v1.54/platform-tools/rust/bin/rustc" ]]; then
  cargo-build-sbf --install-only --tools-version v1.54 > .local/logs/sbf-tools-install.log 2>&1
fi
bash scripts/check-tools.sh
