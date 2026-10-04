# Local development

Compilation, local RPC health, canonical protocol encoding, EVM settlement,
and one-time Anchor initialization have been verified within their respective
test scopes. The EVM Settlement implements atomic purchases, permanent
cancellation, and terminal replay handling. The Anchor program currently
exposes `initialize`, `create_order`, and `request_cancel`. Order creation
atomically deposits legacy SPL cash into the canonical escrow, counts the deposit
in permanent Accounting, and persists a permanent identity;
exact creation replay preserves accounts without another deposit. User-signed
cancellation records intent while keeping cash locked; exact cancellation replay has no additional effect. Receipt acceptance, reimbursement,
refunds, YES issuance, and cross-chain transport/integration are not implemented.

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
bash scripts/check-solana-initialization.sh
bash scripts/check-solana-orders.sh
bash scripts/check-solana-cancellation.sh
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

The fixed public program ID is
`7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK` in source, Anchor.toml,
IDL, and the local initialization fixture. A clean build can generate a disposable
build key; `--ignore-keys` permits it to differ from that fixed ID. The private
build key is never a publication artifact. The initialization runner uses
`--upgradeable-program <ID> <SBF binary> <disposable authority>` to load the
program and genuine linked loader ProgramData at genesis. This is a local test
fixture, not a production deployment procedure or evidence of a public deployment.

RPC checks reserve ports 18545 (Anvil), 18899/18900 (Solana RPC/WebSocket),
18901 (faucet), and 19010–19040 (validator services). Occupied ports cause failure;
existing nodes are neither used nor stopped. Startup has a 60-second deadline
per node. The script suppresses Anvil key output, creates disposable local-only
keys, supplies an isolated Solana configuration, and stops only its own child
processes. It does not alter the default Solana wallet/RPC configuration.

## Verified results and build notes

- Forge compilation and formatting checks passed for the existing EVM contracts
  using Solidity 0.8.30.
- `cargo check --workspace --locked` and `cargo fmt --all -- --check` passed.
- Anchor produced the SBF binary and JSON/TypeScript IDL with exactly
  `initialize`, `create_order`, and `request_cancel` at the unchanged public
  program ID.
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
tests or evidence of cross-chain safety. The 13 existing Rust encoding tests
remain separate from validator integration checks.

## One-time initialization check

After building with `bash scripts/check-builds.sh`, run:

```bash
source scripts/env.sh
npm --prefix harness run typecheck
npm --prefix harness run check:imports
bash scripts/check-solana-initialization.sh
```

The shell wrapper selects the existing isolated tools. The Python runner requires
the generated SBF/JSON IDL artifacts; the TypeScript test uses the generated
IDL type helper and existing Anchor/web3/SPL clients with Node's built-in test
runner. It checks the same Solana TCP/UDP ports as the RPC check before startup,
then runs in a fresh unprivileged user/network namespace containing only the
loopback interface. It creates a unique ignored `.runtime/initialization-*` directory
for the ledger, disposable keys, explicit CLI configuration, and diagnostics.
An unrelated upgradeable genesis fixture has the same upgrade authority and is
used only to test the ProgramData binding; it is never invoked as the application.
Eight ticks per slot shorten local tests without changing finalized commitment.
Agave 4.1.2's test-validator CLI hardcodes wildcard RPC/WebSocket/faucet listeners;
`--bind-address 127.0.0.1` alone limits the other validator services. See its
[faucet address](https://github.com/anza-xyz/agave/blob/v4.1.2/validator/src/bin/solana-test-validator.rs#L187)
and [RPC configuration](https://github.com/anza-xyz/agave/blob/v4.1.2/test-validator/src/lib.rs).
The namespace therefore isolates the entire runner, validator, tests, and CLI
operations on loopback, with no external network interface or route. Existing
Linux `unshare` and `ip` are required, with permission to create unprivileged
namespaces; failure to create that isolation fails the check. No host interface,
firewall, or default network configuration is changed. Ports are checked both
on the host before isolation and inside the namespace before startup.
Agave 4.1.2's default test feature set activates SIMD-0500, which rejects
`SetAuthority(None)` for SBPF v0/v1/v2. To retain the pinned `--arch v0` artifact
and exercise genuine authority removal, this disposable genesis alone deactivates
`disable_sbpf_v0_v1_v2_deployment`
(`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`). See the exact
[Agave 4.1.2 loader check](https://github.com/anza-xyz/agave/blob/v4.1.2/programs/bpf_loader/src/lib.rs#L541)
and [feature ID](https://github.com/anza-xyz/agave/blob/v4.1.2/feature-set/src/lib.rs#L1168).
This fixture configuration does not change dependencies, global configuration,
or the application's authorization model, and results apply to this local feature
set rather than the validator's default feature set.
Readiness is bounded to 60 seconds and tests to 900 seconds. Cleanup terminates
only owned process groups and checks that their ports are released, including
failure paths. No default Solana wallet/RPC settings are edited.

`Config` is a singleton at `[b"config"]`, allocated once with Anchor `init` and
the canonical bump: 572 bytes of data plus the 8-byte discriminator (580 bytes).
It stores version 1; both 32-byte deployment domains; `crate::ID`; the complete
32-byte big-endian EVM chain ID; six raw 20-byte EVM addresses (settlement, venue,
cash token, YES token, operator, executor); the 32-byte market and fixed YES
outcome 0; Solana operator/executor; validated cash/YES mints and executor cash
ATA; the derived YES mint authority; exact legacy token, associated-token, and
system programs; and the configuration/YES authority bumps. There are no
configuration setters or reset/close paths. Config contains no aggregate
accounting counters or order records; separate permanent accounts store them.
Initialization also creates the canonical `[b"accounting", config_pubkey]` PDA
using `init`, with 105 bytes including its discriminator, stored Config, canonical
bump, and four zero u128 counters. Config and Accounting succeed or fail together;
neither record can be reset, closed, backfilled, or initialized lazily.

`Signer` proves possession of a signing key, not deployment authorization.
The executable program must have this exact ID and belong to the upgradeable
loader. Its linked ProgramData must match the supplied typed loader-owned
ProgramData, whose current upgrade authority must equal the initializer signer.
Accepting any ProgramData with that signer would allow an unrelated deployment
to authorize this program. The initializer pays both records' rent.

Real SPL setup transactions prepare legacy six-decimal mints without freeze
authorities, zero initial YES supply under `[b"yes-authority", config_pubkey]`,
and the existing executor cash ATA. Initialization validates all identities,
canonical bindings, account state, delegate/close authority restrictions, and
fixed executable programs. It neither creates the ATA nor transfers tokens,
mints YES, or changes mint authorities. EVM inputs are trusted initialization
values: Solana cannot inspect EVM storage or prove those contracts exist.
Matching actual EVM deployment configuration remains a later integration check.

Distinct Node subtests cover unauthorized first callers, a non-signing authority
with a separate fee payer, substituted program/ProgramData accounts, invalid
configuration, real SPL mint/account variations, and Token-2022 substitution.
Rejected attempts are sent with preflight disabled, then require finalized
failed transaction metadata, the expected on-chain error, no Config or Accounting
creation, and unchanged raw fixture token/mint state. A timeout or client construction
failure fails the test. Successful initialization checks every stored field
against an independently assembled byte layout, canonical PDAs/bumps, ownership,
exact space, rent exemption, and unchanged token state. Both identical and
changed reinitialization attempts must fail without changing either record or
tokens.

Finally, the real local `solana program set-upgrade-authority --final` operation
removes the authority. The test reads back loader ProgramData with authority
`None` and confirms Config and Accounting remain readable and byte-for-byte
unchanged.
It does not treat an existing-Config rejection as evidence of the
missing-authority branch. Per-run `tests.log`, `validator.log`,
`remove-authority.log`, and `evidence.json` preserve public transaction signatures
and results without printing private keys. Run the wrapper twice to verify
independence from prior ledgers and fixture state.

Verified on 2026-10-03: both fresh isolated runs passed all 48 named validator
subtests (49 Node tests including the parent), with 45 finalized rejected
transactions per run, no skipped cases, and all owned processes/ports cleaned
up. The 13 Rust encoding tests, locked host checks, formatting, SBPF v0 build,
exact IDL instruction assertion, TypeScript typecheck/import check, and
`git diff --check` passed. Both lockfiles and dependency pins were unchanged.
A separate occupied-host-port check failed startup as intended before fixture
creation, then released its own listener. Builds still emit the existing LTO
and bigint fallback warnings; Foundry also reported a nonfatal signature-cache
write failure outside the repository under the filesystem sandbox.

## Atomic order creation check

```bash
source scripts/env.sh
(cd solana && cargo check --workspace --locked)
(cd solana && cargo fmt --all -- --check)
(cd solana && cargo test --workspace --locked)
(cd solana && anchor build --ignore-keys --tools-version v1.54 --arch v0)
npm --prefix harness run typecheck
npm --prefix harness run check:imports
bash scripts/check-solana-orders.sh
bash scripts/check-builds.sh
git diff --check
```

The orders wrapper selects the existing validator runner's explicit `--orders`
mode. It first runs the initialization suite, including genuine loader
upgrade-authority removal, then runs `test:orders` on that same validator.
`check-solana-initialization.sh` remains initialization-only. Both IDL guards
require exactly `initialize`, `create_order`, `request_cancel`, and
`accept_filled`, regardless of IDL sorting.
Namespace isolation, the documented local SIMD-0500 genesis setting, readiness,
a 900-second deadline per suite, process-group cleanup, and TCP/UDP port-release
checks are shared. Socket/namespace access may require execution outside the
filesystem sandbox; no application/network authorization changes are involved.

`create_order` accepts only uint64 nonce, cash amount, and minimum shares. It
requires the original user signer, distinct from the fixed Solana roles, and
reads all deployment/market identity from the canonical immutable Config. It
uses the SPEC big-endian nonce PDA seeds and the existing Rust canonical hash
and checked amount/nonce helpers. Positive unattainable minima are allowed.
ProgramData and deployment authority are absent from its account list.

UserNonce remains 81 bytes including its discriminator. Order allocates its
maximum 335 bytes, including capacity for a future 41-byte accepted receipt;
neither layout changes. Escrow is a 165-byte legacy SPL token account whose
authority is the Order PDA, without delegate or close authority. Mint checks
retain six decimals and safe authorities but do not restrict current YES supply.
Canonical user ATAs must have the configured mint, original user owner, and
initialized/unfrozen state. Account types/owners, canonical seeds/bumps, stored
relationships, executable program identities, and unsafe aliases are checked.
`Box<Account<...>>` keeps Anchor account validation within SBPF v0 stack limits.

Only `init-if-needed` is added to the existing pinned anchor-lang dependency.
Fresh zero-filled identity records are identified by their default config field;
all persisted identities contain the real nonzero Config key. Existing records
must match their stored user/config/bump and order relationships. There are no
close, reset, reassignment, or record-clearing paths, so existing identities
cannot be converted back into fresh records. The escrow uses generic Anchor
allocation with the legacy SPL owner, then explicit legacy `InitializeAccount3`
for a new zero-filled escrow. This avoids Anchor 1.2.0's token-init macro requiring
Token-2022 runtime features. An existing order requires an already initialized,
valid escrow; missing escrow replay fails atomically rather than recreating a
deposit. Successful exact replay performs neither system nor token CPI.

After authorization/bindings, existing creation verifies full terms and canonical
hashes and returns without changing lifecycle, cancellation flag, receipt,
nonce, or balances. It does not require Pending, the original escrow balance,
or cash for another deposit. Changed valid terms return `TermsConflict`. New
creation checks the next nonce, calls checked `record_deposit` once, then transfers
exactly the deposit via `transfer_checked`, reloads and verifies both token balance
deltas, persists all Order fields in Pending, and advances the counter once.
Account rent, allocation,
escrow initialization, transfer, order persistence, and counter advancement are
one atomic transaction, including the Accounting update. Only successful new
creation emits `OrderCreated`. A failed transfer preserves the complete Accounting
record, including for fresh and existing UserNonce accounts.

Anchor's IDL generator permits one error enum, so `configuration.rs` also gains
the creation variants in its existing enum, starting explicitly at code 7000.
Initialization's existing codes remain unchanged; Config layout is unchanged.
Accounting errors reserve 9000 onward in the same enum. Invalid cash amounts
retain their existing creation codes; arithmetic overflow and payouts exceeding
deposits remain distinct errors.

The creation suite uses actual signed transactions, legacy SPL fixtures, and
independently concatenated Node crypto SHA-256 preimages with explicit uint64
big-endian encoding. Amounts and nonces use bigint/Anchor BN throughout. It
checks every first-order byte, maximum allocation, ownership, rent, balances,
counter, hashes, and event fields; second/other-user orders; stale/underfunded
replay; donated escrow replay; conflicting terms; amount/nonce bounds; missing
signature; substituted account/PDA/mint/ATA/program identities; Token-2022;
and failed transfer rollback followed by same-identity replenishment/retry.
Each rejection requires finalized executed failure with the expected log error
and unchanged tracked raw data, token balances/supply, account existence, and
user rent. A separate faucet pays transaction fees. Both a fresh UserNonce and
an existing counter are checked through failed transfers. Public transaction
signatures and outcomes remain in ignored `orders-evidence.json` and `orders.log`
under the runner's unique `.runtime/initialization-*` directory.

No production test hooks or validator storage mutations are used. Lifecycle
replay is unrestricted in code; terminal-state on-chain replay awaits later
business instructions. Arithmetic exhaustion remains covered by existing host
tests. Deposit accounting is verified with real creation instructions; payout
accounting awaits receipt processing. These checks establish local order creation and
replay only, without settlement/refunds, YES issuance,
transport, EVM integration, or a cross-chain demo.


Verified on 2026-10-04: the combined fresh-validator run passed 48 initialization
subtests (49 Node tests including the parent) and 45 creation subtests (46 Node
tests including the parent), without failures or skips. Creation evidence records
six successful new orders, six exact replays, and 34 finalized rejected
transactions. Initialization records 45 finalized rejections. Both fresh-counter
and existing-counter insufficient-cash attempts rolled back fully; replenishment
then succeeded once and replay preserved state. Owned processes stopped and all
reserved TCP/UDP ports were released. The 28 existing Rust host tests, locked
check, formatting, pinned SBF/IDL build, TypeScript checks, aggregate build script,
and tracked/new-file whitespace checks passed. Pins, both lockfiles, Config and
order layouts, canonical encoding, and the program ID remained unchanged.
Initial compile issues (token-init macro features, account-validation stack size,
and multiple error enums in IDL) and TypeScript test callback return types were
resolved. Remaining warnings are the existing LTO/bigint fallback warnings and a
nonfatal Foundry signature-cache write failure under the filesystem sandbox.

## User cancellation request check

```bash
source scripts/env.sh
(cd solana && cargo check --workspace --locked)
(cd solana && cargo fmt --all -- --check)
(cd solana && cargo test --workspace --locked)
(cd solana && anchor build --ignore-keys --tools-version v1.54 --arch v0)
npm --prefix harness run typecheck
npm --prefix harness run check:imports
bash scripts/check-solana-cancellation.sh
bash scripts/check-builds.sh
git diff --check
```

The cancellation wrapper selects explicit `--cancellation` mode: initialization,
creation, then cancellation run sequentially on one fresh isolated validator.
Initialization-only and orders-only wrappers retain their existing suite choices.
The same genesis feature setting, namespace isolation, readiness checks, suite
deadlines, ignored evidence directory, and owned process/port cleanup apply.

`request_cancel(nonce, expected_terms_hash)` requires only the original user
signer, read-only canonical Config, and writable existing canonical Order. Anchor
checks ownership/discriminators and canonical seeds; the handler validates
configuration version/program/domain bindings, stored order relationships,
market/outcome, amount bounds, canonical ID/hash, expected hash, stored user ATA
addresses, and escrow address/bump on every request including replay. ATA and
escrow derivation checks require no live token accounts. No UserNonce, token,
system, deployment-authority, or operator accounts are required.

A consistent Pending record changes only state and cancellation flag and emits
one `CancellationRequested` event containing Config, user, Order, nonce, order ID,
and terms hash. A consistent CancelRequested replay has no event or mutation.
Terminal replay requires a prior cancellation and a consistent retained receipt;
new terminal requests and inconsistent state/flag/receipt combinations fail
without mutation. The small Rust transition helper validates terminal receipt
tag, exact quantity/minimum, and hash without accepting or writing any receipt.
Refunded without a prior request is an inconsistent record. Shared errors reserve
8000 onward; earlier initialization and creation codes remain unchanged.

Cancellation never calls token/system programs, allocates rent, advances nonce,
releases funds, or establishes refund eligibility by itself. It performs no EVM
call or receipt acceptance. No timeout payout, administrator override, or reset
path exists. Config/UserNonce/Order layouts, canonical encoding, program identity,
dependency pins, lockfiles, initialization, and creation logic are preserved.

The focused validator suite creates fresh signed users and real orders after
genuine upgrade-authority removal. Raw account snapshots include Config, orders,
Accounting, nonce counters, escrow, user/executor token accounts, mint supplies,
rent, and user SOL; only the two lifecycle bytes may change on a first request.
Transaction fees are checked separately against a fresh fee payer funded with
10 SOL (within the
JavaScript safe integer range); the large genesis faucet is excluded from fee
arithmetic. Replays and finalized executed
failures preserve every tracked byte and balance. Successful cancellation and
creation replay logs and inner-instruction records must show no CPI. The suite
also covers advanced nonces, independent users, zero user cash, closed user ATAs,
wrong signers/accounts/nonces/hashes, nonexistent orders, escrow donations,
creation replay after cancellation, and subsequent order creation. Public
signatures and outcomes remain in ignored `cancellation-evidence.json` alongside
`cancellation.log`; credentials remain local and are never printed.

Terminal cancellation replay is verified only with realistic host receipt
fixtures until real receipt-processing instructions exist. No validator storage
injection or production test hooks are used. Deposit accounting is verified;
receipt processing and payout/issuance counter updates remain unimplemented.


Verified on 2026-10-04: the combined fresh-validator run passed 48 initialization,
45 creation, and 27 cancellation subtests (49, 46, and 28 Node tests including
their parents), without failures or skips. Cancellation evidence records six
real creations, four first requests, six cancellation/creation replays, and 16
finalized executed rejections. Every first request changed only Order state/flag;
replays preserved complete snapshots with no token/system CPI, payment, or nonce
increment. Donations remained locked, zero-cash requests succeeded, and closed
user ATAs were not recreated. All 34 Rust host tests (including six cancellation
tests), locked check, formatting, pinned SBF/IDL build, TypeScript checks,
aggregate build, and whitespace checks passed. Owned processes stopped and all
reserved TCP/UDP ports were released. Runtime evidence remains under ignored
`.runtime/initialization-iexqluwf/`.

The first cancellation run exposed rounding in a test's fee comparison against
the oversized genesis faucet. A separate fee payer within the JavaScript safe
integer range corrected the test; the complete three-suite run then passed on a
fresh validator. No program changes were needed for that test correction. The
existing LTO, bigint JavaScript fallback, and nonfatal sandboxed Foundry
signature-cache warnings remain. Terminal replay coverage remains host-only;
there is still no receipt processing, source payout, or cross-chain demo.

## Source deposit accounting check

Use the commands in the cancellation check above to run all three existing
suites sequentially on one fresh validator. Historical ignored ledgers belong
to prior immutable deployments; do not reuse or modify them for the new binary.

The client account lists for `initialize` and `create_order` now require
Accounting immediately after Config. Initialization creates it once under the
same linked ProgramData/upgrade-authority authorization. Creation requires the
existing writable typed account and checks its owner/discriminator, canonical
PDA/bump, stored Config, and unsafe aliases on NEW and replay paths.
`request_cancel` retains exactly its three accounts and performs no CPI.
Config (580), UserNonce (81), Order (335), and Accounting (105) allocations and
layouts, instruction arguments, program ID, encoding vectors, dependency pins,
and both lockfiles remain unchanged.

The validator suites independently reconcile their starting totals from all
permanent orders for Config; creation inputs then advance a bigint expected
total only after successful NEW creation. Independently serialized u128 bytes
verify that only `total_deposited` changes. Snapshots cover missing/substituted
Accounting, terms and amount/nonce rejection, failed transfers with fresh and
existing nonces, replenishment/retry, stale/underfunded replay, and cancellation.
Faucet minting and donations preserve Accounting. Final reconciliation sums
all permanent order cash amounts and verifies each escrow retains its cash plus
separately recorded donations. Refund, reimbursement, and cumulative YES
issuance counters and YES supply remain zero. Evidence includes starting/final
totals, order counts, donation amounts, and public transaction outcomes in the
existing ignored JSON files.

u128 overflow and payout arithmetic boundaries remain covered by the 14 host
accounting tests; on-chain overflow is not claimed. No storage injection or
production hooks are used. Receipt processing, payouts, and YES issuance remain
unimplemented.

Verified on 2026-10-04: one fresh combined run passed 49 initialization, 53
creation, and 27 cancellation subtests (50, 54, and 28 Node tests including
parents), with no failures or skips. Initialization verified all-zero Accounting,
exact serialization/rent, atomic rejection, reinitialization rejection, and
preservation after genuine authority removal. Creation recorded six orders,
six exact replays, and 42 finalized rejections; deposits reached 50,000,001 base
units. Cancellation independently began at that total and recorded six further
orders, four first requests, six cancellation/creation replays, and 16 finalized
rejections. Final deposits were 110,000,001 across 12 permanent orders, with
14 donation units tracked separately. All cash stayed locked, all other counters
and YES supply stayed zero, and failed transfers/retries and cancellation
preserved the required accounting bytes.

All 48 Rust host tests, locked workspace check, formatting check, pinned SBF/IDL
build, TypeScript typecheck/import check, aggregate build, and whitespace check
passed. The generated IDL contains Accounting, the two required account-list
additions, exactly the existing three instructions, the unchanged program ID,
and distinct new error codes 9000–9002 without changing previous codes. Owned
processes stopped and all reserved TCP/UDP ports were released. Evidence remains
under ignored `.runtime/initialization-m7h2f7a8/`. The runner needed socket and
namespace access outside the restricted filesystem sandbox. Existing LTO,
bigint JavaScript fallback, and nonfatal Foundry signature-cache write warnings
remain; arithmetic overflow and terminal cancellation replay coverage remain
host-only.


## Atomic Filled settlement check

```bash
source scripts/env.sh
(cd solana && cargo check --workspace --locked)
(cd solana && cargo fmt --all -- --check)
(cd solana && cargo test --workspace --locked)
(cd solana && anchor build --ignore-keys --tools-version v1.54 --arch v0)
npm --prefix harness run typecheck
npm --prefix harness run check:imports
bash scripts/check-solana-filled.sh
bash scripts/check-builds.sh
git diff --check
```

The Filled wrapper selects explicit `--filled` mode: initialization, creation,
cancellation, then Filled acceptance run on one fresh validator. Existing modes
retain their suite choices. Both IDL guards require exactly `initialize`,
`create_order`, `request_cancel`, and `accept_filled`. The same loopback namespace,
local SIMD-0500 genesis limitation, owned process cleanup, and port checks apply.
The initialization fixture saves its generated operator credential with mode
0600 under the ignored per-run `.runtime` directory for the later signed suite;
the credential is never printed or included in public transaction evidence.

`accept_filled` accepts typed Borsh argument adapters containing full immutable
terms and receipt fields. These explicitly convert to the existing canonical
encoding types; SHA-256 still hashes fixed-width big-endian protocol preimages,
including the complete 32-byte EVM chain ID. No account layout, prior instruction
interface, program ID, dependency pin, lockfile, or encoding vector changes.
The existing error enum appends codes 10000–10010 while retaining earlier codes.

The configured operator signs; the original user is a readonly identity without
a signature requirement. Existing typed program/SPL accounts authenticate owners
and discriminators. Canonical PDAs/bumps, Config domains/program/roles and pinned
programs, Accounting, permanent UserNonce, Order, stored and independently derived
user YES ATA, escrow, executor cash ATA, and mint authority must all match.
The stored user cash ATA is also independently derived, without requiring a live
cash account. Mints are initialized, distinct, six-decimal, and have no freeze
authority; current YES supply may be nonzero. Escrow and reimbursement accounts
must have safe initialized state with no delegate or close authority. The YES
authority PDA authenticates signing seeds without a program-owned data account.
No allocation, account closure, authority rotation, or alternate payout exists.

After account checks, `validate_filled_receipt` decides Apply or Replay. An exact
Settled replay returns before balance/capacity checks, counters, CPIs, events, or
mutation, even with depleted escrow or owner-burned YES. A new fill calls
`Accounting::record_fill`, then legacy `MintToChecked` signed by YES authority,
then `TransferChecked` signed by Order. The pinned legacy Anchor SPL module lacks
a checked-mint wrapper, so the handler constructs that instruction through its
existing SPL re-export and invokes it directly. Relevant accounts/mint reload;
exact supply and balance deltas must match before persisting Settled and the
accepted receipt and emitting one `FilledAccepted`. Cancellation history stays
unchanged. Escrow donations remain after reimbursing only the original cash.
All operations share one Solana transaction; errors propagate and roll back.

The focused suite uses a separate fee payer, actual SBF execution, finalized
metadata, independent Node crypto hashes, bigint/BN amounts, and complete raw
account snapshots. Actual inner instruction bytes prove checked mint/transfer
amounts, decimals, CPI order, and canonical accounts independently of optional
SPL instruction log labels. It checks Pending and CancelRequested settlement, receipt and
event fields, exact payout/issuance, counters and unchanged nonce/history,
replay without CPI/events, user burns, donations, terminal creation/cancellation
replays, missing and genuinely signed wrong operator, representative account and
input substitutions, and minimum-output rejection. Public evidence is written
only to ignored `filled-evidence.json`; user-authorized burns are tracked
separately from cumulative issuance.

The last scenario burns earlier fixture YES legitimately, fills the largest
valid order to supply `u64::MAX - 1`, and attempts a two-unit fill. The actual
legacy mint CPI must report overflow before reimbursement; the complete failed
transaction must preserve Order/receipt/history, Accounting, escrow, executor,
user balance, and mint supply. A genuine owner burn frees two units; the same
order then settles once, followed by exact replay. Cumulative u128 issuance can
exceed u64 while current mint supply remains valid. No program-owned storage
mutation or production test hook is used.

Receipts are authorized operator attestations. This instruction does not prove
an EVM purchase or verify EVM finality. The future off-chain observer must check
terminal EVM storage, the successful matching receipt, and the specified policy
of two additional mined blocks, using finalized Solana observations. Hashes bind
content; they are not execution proofs. A dishonest or compromised operator can
fabricate fills and break backing; an unavailable operator can delay settlement.
Cancelled acceptance/refunds, transport, cross-chain integration, and verification
of failure in the second CPI after a successful mint remain pending. A failed
first mint CPI does not establish that second-CPI rollback scenario. This remains
independent educational work with an explicitly trusted operator.

Verified on 2026-10-04: the fresh combined run passed 49 initialization,
53 creation, 27 cancellation, and 34 Filled subtests (50, 54, 28, and 35 Node
tests including parents), with no failures, skips, or cancellations. The prior
suites recorded 46, 42, and 16 finalized rejections. Filled evidence recorded
52 finalized transactions, including seven real creations, five successful
fills, eight protocol replays, two cancellation requests, three legitimate
user burns, and 27 executed rejections. Every successful fill had exactly the
checked mint and reimbursement CPIs and one event; replay had neither CPI nor
event and preserved every tracked account byte.

The actual supply-boundary rejection returned SPL custom error 14 (overflow)
from the sole attempted MintToChecked CPI, before reimbursement. Complete raw
snapshots, including the prior cancellation flag, remained unchanged. Burning
two units then allowed the same receipt to settle once and replay without
effect. Final cumulative issuance was 18,446,744,073,769,551,616 units,
owner burns totaled 60,000,002, and current supply was
18,446,744,073,709,551,614. Deposits were 9,223,372,037,004,775,810 and
reimbursements 9,223,372,036,884,775,808 across 19 permanent orders; refunds
remained zero. All outstanding escrows and independently tracked donations
reconciled. Public signatures, finalized slots, results, and burn records remain
in ignored `.runtime/initialization-_2ufjtjh/filled-evidence.json`. Owned processes
stopped and all reserved TCP/UDP ports were released.

All 90 existing Rust host tests, locked workspace check, formatting check,
pinned SBF/IDL build, TypeScript typecheck/import check, aggregate build, and
tracked/new-file whitespace checks passed. A separately generated IDL from the
starting source snapshot confirmed that every previous instruction, account,
type, event, error code/message, and metadata entry is identical. Additions are
limited to Filled acceptance, its four argument types, event, and reserved
errors. Account layouts, program identity, dependency pins, lockfiles, and
canonical vectors remain unchanged.

The first Filled run exposed a test assumption about optional SPL instruction
log labels. Direct verification of actual CPI bytes/accounts replaced that
assumption while retaining all state and economic assertions; the complete run
then passed on a fresh validator. The original-IDL compatibility build initially
shared host artifacts with the current build; cleaning the local package
artifacts and rebuilding restored the current IDL, and both compatibility and
aggregate checks passed again. Remaining nonfatal warnings are the existing
LTO limitation, bigint JavaScript fallback, and sandboxed Foundry signature-cache
write failure. Socket/namespace access required running the isolated validator
outside the filesystem sandbox. EVM execution/finality, Cancelled/refund,
transport/cross-chain behavior, and second-CPI failure remain unverified here.

## Filled reimbursement failure after successful mint

```bash
source scripts/env.sh
(cd solana && cargo check --workspace --locked)
(cd solana && cargo fmt --all -- --check)
(cd solana && cargo test --workspace --locked)
(cd solana && anchor build --ignore-keys --tools-version v1.54 --arch v0)
npm --prefix harness run typecheck
npm --prefix harness run check:imports
bash scripts/check-solana-filled-rollback.sh
bash scripts/check-solana-filled.sh
git diff --check
```

The rollback wrapper selects explicit `--filled-rollback` mode in the existing
isolated runner. It runs initialization, including genuine upgrade-authority
removal, then the new test's runner-selected `prepare` phase. A genuine user
deposits 10,000,000 cash units with a minimum of 20,000,000 YES units and requests
cancellation. Preparation checks CancelRequested, retained cancellation history,
no accepted receipt, exact deposit/accounting, zero YES issuance, and the permanent
nonce. All transactions are finalized before account export. Fixture credentials
are stored with mode 0600 only in the ignored per-run `.runtime` directory.

The runner exports the pinned CLI's JSON account-dump format, preserving exact
u64 metadata, to `rollback-original`. It includes Config, Accounting, UserNonce,
Order, both mints, every legacy token account for those mints, the required system
accounts, the executable program, and its linked immutable ProgramData. Separate
`rollback-altered` dumps differ only in the escrow token amount at offset 64
(10,000,000 to 9,999,999) and cash mint supply at offset 36 (one unit less).
All other bytes and account fields remain identical. Both original and altered
cash/YES supplies reconcile against all exported token balances.

This deliberately induced local token-account deficit is isolated genesis fault
injection. It is not a reachable normal protocol flow or evidence that users can
drain escrow. There is no runtime storage rewrite, production repair hook, or
change to the program or its authorities. After stopping the first validator and
checking port release, the runner creates a genuinely new ledger and loads the
altered dumps with `--account`. It loads the executable and ProgramData directly,
without redeployment. A new Node process discards the old ledger's slots and
blockhashes. The second genesis faucet uses a separate local identity because
the validator's default faucet would replenish the CLI keypair's exported SOL
balance. The `verify` phase compares loaded snapshots, checks account/PDA
bindings and mint capacity, verifies exact compiled SBF bytes and absent upgrade
authority, and excludes the separate fee payer from tracked protocol accounts.

The configured operator submits unchanged full Filled terms and receipt, without
the original user's signature, using `skipPreflight`. The test requires actual
finalized transaction metadata: exactly two ordered legacy token CPIs, authenticated
by their instruction bytes, account order, amounts, and six decimals. The first
MintToChecked must return success; the subsequent TransferChecked must return SPL
insufficient-funds error 1, propagated by the settlement program. No third CPI or
terminal event is allowed. Complete before/after snapshots include exact u64 lamports
(preserved as decimal strings before JSON parsing, including the large genesis balance),
ownership, executable flags and data for every tracked account, proving that
Order, cancellation history, nonce, Accounting, YES supply/balance and cash
balances all roll back. Transaction fees affect only the separate fee payer.

A genuine authorized legacy SPL cash MintTo restores one unit to the canonical
escrow. The test requires restoration of the original tracked snapshot and token
conservation, without changing source state or counters. This restores the test
fixture; it is not a production recovery mechanism. The identical receipt then
settles once, with exactly one mint and reimbursement, the independently encoded
receipt/hash, retained cancellation history, and exact counter/balance changes.
Exact replay must preserve every tracked byte and have no CPI or event.

Public evidence is saved as `filled-rollback-evidence.json` under the runner's
unique ignored `.runtime/initialization-*` directory. It records ledger/phase
labels, program identity, artifact SHA-256, genesis alterations, finalized
signatures/slots/errors, both CPI identities and logs, complete rollback snapshots,
restoration, retry, and replay. It contains no private credentials. Existing runner
modes retain their suite selection, deadlines, loopback isolation and process/port
cleanup. These checks concern local Solana atomic rollback only; EVM execution,
cross-chain behavior, honest operator attestations and production bridge safety
are not established.

Verified on 2026-10-04: a fresh two-ledger run passed 50 initialization, four
preparation, and six verification Node tests (60 total, including parents), with
no failures, skips or cancellations. Cash supply changed from 20,000,000 to
19,999,999 alongside the escrow change from 10,000,000 to 9,999,999, preserving
aggregate token conservation. On the second ledger, the finalized rejection at
slot 25 authenticated CPI bytes `0e002d31010000000006` (MintToChecked,
20,000,000 YES, six decimals) followed by `0c809698000000000006`
(TransferChecked, 10,000,000 cash, six decimals). Logs show the mint returning
success before the transfer reports insufficient funds; final error is
`InstructionError: [0, {Custom: 1}]`. No terminal event appeared and all 19
tracked account snapshots were preserved, including cancellation history and
exact u64 lamport balances.

Authorized fixture restoration finalized at slot 59 and restored the original
tracked snapshot. The same Filled receipt settled at slot 94 with two successful
CPIs and one event, 10,000,000 reimbursed and 20,000,000 cumulatively issued.
Replay at slot 129 had zero CPI/events and preserved the complete snapshot.
Public signatures, CPI accounts/bytes, logs, fixture changes, and artifact
fingerprint remain in ignored
`.runtime/initialization-w1rovxfv/filled-rollback-evidence.json`. The immutable
compiled artifact SHA-256 is
`f44c4770414dbec009e2d9f4a668d86e50c94b8f9c1348c86321fb838c38a9f3`.
Both owned validators and test process groups stopped and their reserved TCP/UDP
ports were released. This closes the second-CPI rollback gap in the preceding
historical Filled result; the EVM/cross-chain limitations remain.

An initial run correctly rejected a loaded snapshot whose cash-authority SOL
balance had been overwritten by the default genesis faucet. Explicitly selecting
a separate faucet fixed fixture loading without weakening snapshot assertions;
the successful run used a new fixture and new ledgers. The existing nonfatal
bigint native-binding warning uses the JavaScript fallback. Socket/namespace
access required executing the isolated runners outside the filesystem sandbox.

The unchanged full Filled runner also passed on a fresh validator: 50
initialization, 54 creation, 28 cancellation and 35 Filled Node tests (167 total),
without failures, skips or cancellations. Its evidence remains under ignored
`.runtime/initialization-ifilyfmm/`; owned processes stopped and ports were
released. Locked workspace check, formatting, all 90 Rust tests, the pinned
Anchor build, TypeScript typecheck/import checks and whitespace checks passed.
SHA-256 comparisons against the starting fixture confirm unchanged complete IDL,
generated types, SBF artifact, dependency lockfiles, Rust source and existing test
suites. Only the five task-authorized files changed; staging remains empty and
HEAD remains `4adbcc1`. No stage, commit, remote configuration or publication was
performed.
