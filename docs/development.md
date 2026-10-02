# Local development

Only compilation and local RPC health are verified. The Solidity library and
Anchor program have no callable business methods/instructions. The TypeScript
file checks client imports without issuing network requests. There is no
settlement implementation, deployment, or cross-chain integration test.

## Pinned environment

Verified on 2026-10-02: Ubuntu 24.04.4 LTS / WSL2, x86_64, kernel
6.18.33.2-microsoft-standard-WSL2; Git 2.43.0. This checkout is at
`/home/milos/dev/cross-chain-settlement-lab`. All paths below are relative to that
root unless prefixed with `~`.

| Component | Exact version | Installed location |
| --- | --- | --- |
| rustup | 1.28.2 | `.local/cargo/bin/rustup` |
| Host Rust / Cargo | 1.99.0 / 1.99.0 | `.local/rustup/toolchains/1.99.0-x86_64-unknown-linux-gnu/bin/`; proxies in `.local/cargo/bin/` |
| AVM / Anchor CLI | 1.2.0 / 1.2.0 | `.local/avm/bin/`; `.local/bin/anchor` selects `anchor-1.2.0` directly |
| Agave Solana CLI / validator | 4.1.2 | `.local/solana-4.1.2/bin/` |
| SBF builder | cargo-build-sbf 4.1.0 | Included in the Agave 4.1.2 distribution |
| SBF platform-tools / rustc | v1.54 / 1.89.0-dev | `~/.cache/solana/v1.54/platform-tools/`; registered in the isolated rustup home as `1.89.0-sbpf-solana-v1.54` |
| Node / npm | 24.21.0 / 11.19.0 | `.local/node-v24.21.0-linux-x64/bin/` |
| Forge / Cast / Anvil | 1.5.1-stable | Existing `~/.foundry/bin/`; commit `b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2` |
| Solidity compiler | 0.8.30+commit.73712a01 | `.local/solc-0.8.30` |

Node, Agave, rustup, and Solidity downloads were checked against their official
SHA-256 manifests/release digests. AVM was built with its upstream lockfile from
the official Anchor v1.2.0 source archive; its downloaded archive hash is pinned
in the installer. Existing system Node 18, npm 9, Yarn, and Foundry are preserved.

Direct npm pins: `@anchor-lang/core` 1.2.0, `@solana/web3.js` 1.98.4,
`@solana/spl-token` 0.4.14, ethers 6.16.0, TypeScript 5.9.3,
`@types/node` 24.19.1, and `@types/bn.js` 5.2.0. Rust pins `anchor-lang` and
`anchor-spl` to 1.2.0. Retain `solana/Cargo.lock` and
`harness/package-lock.json`; the Foundry scaffold has no external dependencies.

The [Anchor recommendation](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0)
is 1.2.0 with Solana 4.1.2. The
[current TypeScript client](https://www.anchor-lang.com/docs/clients/typescript)
is `@anchor-lang/core`, requiring legacy web3.js v1. Host Rust and the SBF Rust
compiler are separate toolchains. Build scripts explicitly select v1.54 and
SBPF v0; no floating toolchain is selected.
SBF rustc reports LLVM 20.1.7 and an unknown commit hash/date; the exact compiler
distribution is pinned by the platform-tools v1.54 release.

## Clean checkout setup and checks

Requirements: native x86_64 Ubuntu/WSL, Git, Bash, Python 3, curl, tar, xz/bzip2,
GNU coreutils, working C/C++ compiler and make, and native Foundry 1.5.1 on PATH.
The verified host already had build-essential 12.10ubuntu1, GCC 13.3.0,
make 4.3, libssl-dev 3.0.13, Python 3.12.3, and OpenSSL 3.0.13. AVM uses rustls;
no additional apt packages or system-wide upgrades were needed. pkg-config,
cmake, clang, and libudev-dev were absent and not required by these builds.

Run from the repository root:

```bash
bash scripts/install-tools.sh
source scripts/env.sh
(cd harness && npm ci --ignore-scripts --no-audit)
bash scripts/check-tools.sh
bash scripts/check-builds.sh
bash scripts/check-rpc.sh
```

The installer checks existing executables before installing missing components;
it never removes another Node installation or changes shell profiles. Rust,
AVM, Node, Solana CLI, npm cache, and downloads live in ignored `.local/`.
Agave's builder stores platform-tools in its upstream user cache location shown
above. First installation/build needs access to official Rust, GitHub, Node,
Solidity, crates.io, and npm download services. RPC checks use loopback only.

Build outputs: `evm/out/`, `evm/cache/`, `solana/target/deploy/settlement_lab.so`,
`solana/target/idl/settlement_lab.json`, and `solana/target/types/settlement_lab.ts`.
Build logs and RPC evidence remain under `.local/logs/`. Runtime ledgers, wallet
files, and per-run logs remain under `.runtime/`; all are ignored.

The public program ID is a compile-only identity, not an active deployment.
A clean build can generate a new disposable key; `--ignore-keys` allows that key
to differ from the fixed source/IDL ID. The private build key is never a
publication artifact. Before any future deployment, explicitly select the real
local key/ID and synchronize the configuration and source; no deployment is
performed by these scripts.

RPC checks reserve ports 18545 (Anvil), 18899/18900 (Solana RPC/WebSocket),
18901 (faucet), and 19010–19040 (validator services). Occupied ports cause failure;
existing nodes are neither used nor stopped. Startup has a 60-second deadline
per node. The script suppresses Anvil key output, creates disposable local-only
keys, supplies an isolated Solana configuration, and stops only its own child
processes. It does not alter the default Solana wallet/RPC configuration.

## Verified results and build notes

- Forge compiled the empty library using Solidity 0.8.30; formatting passed.
- `cargo check --workspace --locked` and `cargo fmt --all -- --check` passed.
- Anchor produced a 57,072-byte SBF binary and JSON/TypeScript IDL with zero
  instructions; the program ID matches the current disposable build key.
- TypeScript's full declaration check and the import check passed. Dependencies
  are installed without lifecycle scripts; the optional bigint-buffer native
  addon is absent and emits a warning before using its working JavaScript fallback.
- Solana returned `getHealth: "ok"` and `getVersion.solana-core: "4.1.2"`.
- Anvil returned `eth_chainId: "0x7a69"` (31337) and `eth_blockNumber: "0x0"`.

AVM 1.2.0's proxy embeds an older Solana-version catalog/map. It can reject
4.1.2 or resolve 3.1.10 outside the workspace. The environment instead selects
the official AVM-installed Anchor 1.2.0 binary directly, with native Solana
4.1.2 already on PATH; the version pair is unchanged. An unintended fallback
installation/profile entry was removed from the active user environment and
retained in ignored `.local/avm-fallback/` for diagnostics.

The published anchor-spl 1.2.0 IDL module references `token_interface`
unconditionally. The `idl-build` feature enables `anchor-spl/token_2022` only
for host IDL generation. Normal SBF builds select legacy `token` and
`associated_token`; this adds no Token-2022 protocol support. Macro cfg names
are declared explicitly to keep host checks clean. Agave also warns that the
standard `cdylib` + `lib` targets prevent LTO; the build still succeeds.

Anchor forwards additional Cargo arguments to both SBF and IDL test runners;
passing `--locked` through those separators breaks one runner. The build helper
runs a locked host check and verifies that Cargo.lock remains byte-for-byte
unchanged through Anchor's build. These are compilation checks, not settlement
tests or evidence of cross-chain safety.
