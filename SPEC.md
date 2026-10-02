# cross-chain-settlement-lab — v1 specification

Status: minimal compilation scaffolds and local RPC health checks are verified.
Settlement business logic and the cross-chain demo are not implemented; no
program deployment or cross-chain integration has been tested. Environment
verified on 2026-10-02.

## Purpose and scope

Demonstrate that execution, cancellation, and delayed receipts cannot give one
buy order both a source synthetic position and a source refund, under the
explicit trusted-operator model below.

This independent educational project is inspired by public cross-chain flows.
It is not Predikt's implementation, a contribution to Predikt, or evidence of a
defect in its system. [Chain support](https://docs.predikt.gg/chain-support),
[positions](https://docs.predikt.gg/positions), and the
[4pto portfolio](https://4pto.io/portfolio) provide relevance only, not internal
implementation knowledge.

Out of scope: bridges, partial fills, sell/redeem, production redemption or
market utility, extra venues/chains, lending, tokenomics, upgradeability,
frontend, general queue infrastructure, and runtime authority rotation.

## Architecture and economics

| Component | Responsibility |
| --- | --- |
| Rust/Anchor on a local Solana validator | Lock real mock SPL cash; persist orders/cancellation; accept operator-attested terminal outcomes; atomically mint real SPL YES and reimburse, or refund. |
| Solidity settlement on Anvil | Spend one fixed executor's prefunded mock ERC20 cash through the configured venue; retain purchased ERC20 YES in custody; persist mutually exclusive terminal outcomes forever. No YES withdrawal, approval-to-third-party, burn, or rescue path. |
| Deterministic mock venue | One fixed market, YES only (`outcome = 0`), price 0.5 mock USD per YES; all tokens have six decimals; full fill or revert, enforcing minimum output. |
| Thin TypeScript harness | Transport requests/receipts, delay/repeat/reorder delivery, observe finality, and recover from chain state. Business rules remain on-chain. |

Cash and shares use integer base units: 1 mock USD or YES = 1,000,000 units.
A fill spends exactly `cash_amount` and returns exactly `2 * cash_amount`
shares. The venue moves cash to its own account and delivers YES to settlement
custody. The settlement pulls cash from the configured executor (using its
allowance), authorizes only the configured venue, and completes the purchase
and terminal record in one EVM transaction. A revert rolls back every effect.
Use plain mock tokens without fees, rebasing, callbacks, or third-party custody
spending powers; guard settlement against reentrancy.

The user's Solana deposit is **not bridged**. EVM liquidity belongs to the
executor; a successful source settlement pays the same cash amount from escrow
to its configured Solana cash account. The source SPL YES token represents mock
EVM inventory and has no redemption promise. Delayed delivery leaves EVM custody
ahead of source issuance and ties up both the deposit and executor liquidity.

## Initialization, authorization, and trust

One explicitly trusted operator has distinct Solana and EVM signing credentials;
one fixed executor has EVM liquidity and a configured Solana reimbursement
recipient. The original Solana user signs creation and cancellation. Source
receipt acceptance requires the configured Solana operator signer; EVM execution
and cancellation require the configured EVM operator caller.

The operator checks the finalized source order, immutable terms, and (for
cancellation) the user's finalized cancellation request before forwarding.
EVM cannot independently verify those source observations. A source operator
signature attests the terminal EVM outcome; it is not a cross-chain proof.
A dishonest/compromised operator can fabricate fills or cancellations and break
backing. An unavailable operator can indefinitely delay issuance, reimbursement,
or refund. Safety claims assume honest attestation, correct local chains, and
the specified programs/tokens; no trustless-security claim is made.

Initialize a singleton Solana configuration once with an authorized deployment
signer, and EVM immutable configuration at construction. Bind both deployment
domains, Solana program, EVM chain/contract, operator keys, executor, venue,
market/outcome, token addresses/mints, token programs, mint authority, and exact
reimbursement account. Initializer authorization must be tied to the deployed
program's deployment authority, preventing first-caller configuration takeover.
Validate the loader-owned ProgramData account linked to this program and require
its current upgrade-authority signer for the one-time initialization.
No setters, authority rotation, administrator refund override, reset, or terminal
record deletion. Make the local Solana deployment immutable after initialization;
upgradeability is not part of v1. Verify matching configurations before orders.

## State transitions

Source creation atomically transfers the deposit, writes immutable terms, and
increments the user nonce. Existing identical creation may return its order
without another deposit or nonce increment; changed terms must fail.

| Source state | Operation / condition | Result and economic effect |
| --- | --- | --- |
| No order | Create with original user signature and next nonce | `Pending`; lock cash once. |
| `Pending` | User requests cancellation | `CancelRequested`; keep all cash locked. |
| `CancelRequested` | Same cancellation request | No-op. |
| `Pending` or `CancelRequested` | Valid `Filled` receipt, exact output and minimum satisfied | `Settled`; mint YES to original user and reimburse executor atomically. |
| `CancelRequested` | Valid `Cancelled` receipt with zero output | `Refunded`; return cash to original user atomically. |
| `Pending` | `Cancelled` receipt | Reject: no user cancellation request. |
| `Settled` or `Refunded` | Exact accepted terminal receipt | No-op: no token CPI, mint, payment, or counter change. |
| Any terminal state | Conflicting outcome, quantity, or terms | Reject. |
| Any state | Timeout observation | No payout; user may sign a cancellation request. |

Persist a `cancellation_requested` flag even after finalization: replay of a
previously accepted cancellation request remains a no-op in a terminal state;
a new cancellation of an already terminal order is rejected. No transition out
of `Settled` or `Refunded`. Failures of any source token operation roll back the
entire finalization, including status and counters, leaving retry possible.

| EVM state | Operation with matching terms | Result and economic effect |
| --- | --- | --- |
| `Unseen` | Execute; venue succeeds | `Filled`; spend executor cash once and retain exact YES output. |
| `Unseen` | Execute; venue reverts (including minimum failure) | Remains `Unseen`; no spending, custody, or terminal record. |
| `Unseen` | Cancel | Permanent `Cancelled` record with exact terms, zero spending/output. |
| `Filled` | Execute again | Return stored `Filled`; no venue call or spending. |
| `Filled` | Cancel | Return stored `Filled`; execution won, no refund entitlement. |
| `Cancelled` | Cancel again | Return stored `Cancelled`; no economic effect. |
| `Cancelled` | Delayed execute | Reject; cannot resurrect the order. |

Validate caller, domains, canonical order ID, market/outcome, and amount bounds
on every request. Every existing EVM record binds full immutable terms and their
hash, not just ID. A reused ID with changed terms always fails, including on
duplicate paths. A venue failure alone never authorizes a refund: a separate
successful cancellation must establish terminal `Cancelled`.

## Identity and canonical encoding v1

Generate two fresh, independent 32-byte deployment-domain values at setup,
persist them in both configurations, and keep them stable on restart. A chain
reset/redeployment is a new demonstration deployment with fresh domains. Actual
keys/addresses are setup outputs; repeated-byte values below are test fixtures.

All encodings are fixed-width byte concatenations. Unsigned integers are
big-endian; public keys use decoded 32-byte Solana bytes and addresses use raw
20-byte EVM bytes. No text addresses, delimiters, padding beyond specified
widths, ABI word expansion, Borsh encoding, or JSON hashing. Hash with SHA-256
(not Keccak-256). Reject unsupported versions and malformed lengths.
Each eight-byte ASCII tag includes the version `01`.

| Field in domain block `D`, in order | Width |
| --- | --- |
| Source deployment domain | 32 bytes |
| Destination deployment domain | 32 bytes |
| Solana program | 32 bytes |
| EVM chain ID | uint256, 32 bytes |
| EVM settlement contract | 20 bytes |

`D` is 148 bytes. Derive `order_id = SHA256(identity_bytes)` from:

| `identity_bytes`, in order | Width |
| --- | --- |
| ASCII `CCSLID01` | 8 bytes |
| `D` | 148 bytes |
| Original Solana user | 32 bytes |
| User nonce | uint64, 8 bytes |

Derive `terms_hash = SHA256(terms_bytes)` from:

| `terms_bytes`, in order | Width |
| --- | --- |
| ASCII `CCSLTR01`, then `D` | 8 + 148 bytes |
| Derived order ID, then original Solana user | 32 + 32 bytes |
| User nonce, then configured market ID | 8 + 32 bytes |
| Market outcome (`0 = YES`) | uint8, 1 byte |
| Cash amount, then minimum shares | uint64 + uint64, 8 + 8 bytes |

Identity and terms are 196 and 277 bytes respectively. Both runtimes recompute
and validate these hashes against configuration and stored order terms.

Receipt bytes are `ASCII("CCSLRC01") || terms_hash || terminal || filled_quantity`
(49 bytes), with `terminal` uint8 (`1 = Filled`, `2 = Cancelled`) and
`filled_quantity` uint64. `Filled` requires `quantity = 2 * cash_amount >=
minimum_shares`; `Cancelled` requires zero. `receipt_hash = SHA256(receipt_bytes)`.
The source instruction includes immutable terms and receipt fields and checks
them against the stored order, with the operator signing the Solana transaction.
Store the accepted terminal fields/hash for replay validation. Transaction hashes
and transport IDs are observation aids, never order identity or authorization.

### Permanent uniqueness and account bindings

Use canonical Solana PDA derivation under the configured program, with these
literal seeds (public keys are raw bytes, nonce is eight-byte big-endian):

| Account | Seeds / required binding |
| --- | --- |
| Configuration | `[b"config"]`; program-owned singleton, never closed/reinitialized. |
| User nonce | `[b"user", config_pubkey, original_user]`; permanent program-owned counter. |
| Order | `[b"order", config_pubkey, original_user, nonce_bytes]`; permanent terms/status/receipt record. |
| Cash escrow | `[b"escrow", order_pubkey]`; legacy SPL token account, configured cash mint, token authority = order PDA, no delegate/external close authority. |
| YES mint authority | `[b"yes-authority", config_pubkey]`; program signs mint CPI with canonical seeds/bump. |

Counters begin at zero. New creation must use exactly `next_nonce`; atomically
advance with checked addition. Once `next_nonce = 2^64 - 1`, reject new creation
rather than wrap (last usable nonce is `2^64 - 2`). Existing identical-order
replays remain possible. No close/reset instructions for identity records;
never use reinitialization to clear terminal status. EVM mappings are permanent.

Anchor must check signer/address, program ownership/discriminator, canonical
seeds/bump, and stored `config`/`user`/terms relations. At creation bind and store
the user's cash and YES associated token account addresses; require their
canonical addresses, token owner = original user, and correct configured mint.
Refund/mint accepts only those stored addresses, never a caller-selected recipient.
User accounts may be recreated at the same canonical address for retry.
Reimbursement accepts only the configured executor cash ATA with matching mint
and token owner. Keep executor and operator distinct from demo users.

All token accounts/mints must be owned by the configured **legacy SPL Token
program** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`), initialized, and of
the correct type; pin the executable token program, associated-token program,
and system program. Token-2022/extensions are outside v1. Cash and YES mints are
distinct, six-decimal mints with no freeze authority; YES starts at zero supply
and has only the configured PDA mint authority. Pin every escrow address and
authority, reject account substitution/unsafe aliasing, and use checked token
transfers. Constraints follow the
[Anchor account reference](https://www.anchor-lang.com/docs/references/account-constraints).

### Arithmetic

Per order: `1 <= cash_amount <= floor((2^64 - 1) / 2) = 9,223,372,036,854,775,807`;
`1 <= minimum_shares <= 2^64 - 1`. Permit an unattainable minimum so execution
can revert and the user can cancel. No division/rounding is needed for price.
Both runtimes enforce these bounds before multiplication or narrowing; Rust
uses checked operations, Solidity checked uint256 operations plus uint64 bounds,
and TypeScript bigint (never Number for amounts/nonces/chain IDs). Supply/account
balances must also fit SPL uint64 limits; exceeding token capacity reverts
atomically. Order-accounting totals use checked uint128-compatible counters;
reject overflow in every runtime. Setup faucet cash minting is separate from
order accounting; it never mints source YES.

### Complete encoding/hash test vector

Fixture values: domains = 32 repeats of hex `11` and `22`; Solana program = 32
repeats of `33`; EVM contract = 20 repeats of `44`; original user = 32 repeats
of `55`; market = 32 repeats of `66`; chain ID = 31337; nonce = 7; outcome = 0;
cash = 10,000,000; minimum/output = 20,000,000. These are encoding fixtures,
not deployed addresses or proof of a valid Solana signer/PDA.

The following is the complete 277-byte `terms_bytes` hex, split at field
boundaries; concatenate lines without whitespace:

```text
4343534c54523031
1111111111111111111111111111111111111111111111111111111111111111
2222222222222222222222222222222222222222222222222222222222222222
3333333333333333333333333333333333333333333333333333333333333333
0000000000000000000000000000000000000000000000000000000000007a69
4444444444444444444444444444444444444444
bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7
5555555555555555555555555555555555555555555555555555555555555555
0000000000000007
6666666666666666666666666666666666666666666666666666666666666666
00
0000000000989680
0000000001312d00
```

```text
order_id     = bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7
terms_hash   = 081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8
Filled bytes = 4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8010000000001312d00
Filled hash  = beb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888
Cancelled bytes = 4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8020000000000000000
Cancelled hash  = acc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b
```

Verified locally using Python 3.12.3 `hashlib` generation, independently encoded
Node.js 18.19.1 `node:crypto`, and OpenSSL 3.0.13 `dgst -sha256` over the generated
binary preimages. All four lengths/hashes matched. Rust and Solidity have **not**
verified this vector yet; later Rust, Solidity, and TypeScript tests must
reproduce the same bytes and hashes.

## Finality, delivery, and restart

Before forwarding execution, await successful source creation at `finalized`
commitment, then read its order/configuration/terms at `finalized` with an RPC
context no older than that transaction's slot. Before forwarding cancellation,
also await the original user's successful cancellation transaction and persisted
request flag at `finalized`; a harness timer cannot sign for the user.

Before attesting an EVM terminal outcome, require a successful transaction
receipt, matching terminal contract storage including terms and quantity, and
two additional mined Anvil blocks (`head >= receipt.blockNumber + 2`). Recheck
the receipt's block hash against the canonical block and terminal storage at
that head. A revert/timeout/event alone is not a terminal outcome. On restart,
recover the creating terminal transaction from contract events/receipts, then
repeat these checks. EVM records/events must expose terms hash, ID, outcome,
and filled quantity. Await source finalization/refund success and persisted state
at `finalized` before reporting completion. This is a local demonstration policy,
not a production finality guarantee.

Restart reconciles permanent source records and EVM records under the persisted
deployment configuration. If destination is terminal and source is nonterminal,
deliver its verified receipt; if source is terminal, validate agreement and do
no economic work. If EVM is `Unseen`, retry execution or forward the finalized
cancellation request as appropriate. Never infer failure from a missing local
acknowledgment. Contradictory chain records stop processing and are reported.
Logs/checkpoints are optional aids; correctness cannot depend on a queue file.

## Invariants and required acceptance scenarios

For order-attributable amounts, exclude gas, SOL rent, faucet setup minting,
and unsolicited transfers; track unsolicited balances separately. Check after
every intermediate operation, replay, revert, and restart, not only at the end:

- Source deposits = outstanding locked cash + cumulative refunds + reimbursements.
- No order is both `Settled` and `Refunded`; EVM never has both terminal outcomes.
- Cumulative source YES minting = sum of accepted `Filled` quantities; each order
  causes at most one mint and reimbursement, or one refund.
- Source YES supply = cumulative minting minus user burns; supply and cumulative
  issuance do not exceed corresponding retained EVM fill custody, assuming
  honest operator attestations. Transfers change ownership, not supply.
- Executor cash spent and venue cash received = sum of completed fill cash;
  settlement YES custody attributable to fills = sum of completed fill quantities.
  Cancelled/reverted/duplicate operations add zero spending/custody.

| Scenario | Required observations |
| --- | --- |
| Happy path | Alice deposits 10 USD (10,000,000), minimum 20 YES (20,000,000). EVM spends executor's 10 USD, retains 20 YES. Delay receipt: source escrow still 10 USD, Alice has zero YES. Deliver `Filled`: escrow pays executor 10 USD, Alice receives 20 SPL YES, source becomes `Settled`. Replay changes no balances/supply/counters. |
| Execution wins cancellation race | Alice reaches `CancelRequested`; EVM fills before cancellation is processed. Cancellation returns existing `Filled`; source accepts it, mints/reimburses, never refunds. |
| Cancellation wins race | User cancellation is finalized; EVM cancel reaches `Unseen` first and permanently records `Cancelled`. Delayed execution fails. Source accepts cancellation receipt, refunds once, mints/pays executor nothing. |
| Timeout / delivery disorder | Receipt can arrive after any demo timeout; escrow stays locked until terminal receipt. User-signed cancellation only; duplicate/reordered request and receipt delivery preserves all invariants. |
| Venue failure | Execution revert leaves EVM `Unseen` and source cash locked. A separate finalized user request and successful EVM cancellation permit refund. |
| Restart | Interrupt after EVM completion, after source completion, and before acknowledgment; reconcile both chains and retry without repeated cash spending, minting, refund, or reimbursement. |
| Atomic failure | Trigger a token-capacity failure or use isolated validator/program-test account fault injection to make reimbursement fail after an earlier mint CPI. State, mint supply, counters, and cash all roll back. Restore the fixture and retry exactly once; no production repair/refund override. |
| Adversarial inputs | Reject wrong signer, ID/terms, original user/recipient, escrow/authority, reimbursement account, mint/token program, deployment domain/program/chain/contract, and conflicting outcome/output. Test changed terms with a reused terminal ID. |
| Bounds / permanence | Check amount and nonce boundaries, counter/supply overflow, unattainable minimum, attempted record reset/reuse, duplicate creation/execution/cancellation/receipt, and user burns versus issuance. |

Eventual verification must include meaningful Foundry fuzz/invariant handlers
that interleave execute/cancel/revert/replay and assert economic balances; tests
of actual Anchor instructions, signer/account constraints, and SPL token CPIs;
and integration scenarios running both local networks with controlled delivery
and restarts. Model-only state tests are insufficient. These application tests
have not been run.

## Verified environment and remaining setup choices

The pinned compile-only environment was verified on 2026-10-02 using native
Linux tools under WSL2. Installation paths, prerequisites, clean-checkout
commands, and build diagnostics are in [development documentation](docs/development.md).

| Component | Verified version |
| --- | --- |
| Git | 2.43.0 |
| rustup | 1.28.2 |
| Host Rust / Cargo | 1.99.0 / 1.99.0 |
| AVM / Anchor CLI | 1.2.0 / 1.2.0 |
| Agave Solana CLI / local validator | 4.1.2 |
| SBF builder | cargo-build-sbf 4.1.0 |
| SBF platform-tools / Rust compiler | v1.54 / 1.89.0-dev; SBPF v0 |
| Forge / Cast / Anvil | 1.5.1-stable |
| Node.js / npm | 24.21.0 / 11.19.0 |
| Solidity compiler | 0.8.30+commit.73712a01; Cancun target |
| Anchor Rust crates / TypeScript client | anchor-lang 1.2.0, anchor-spl 1.2.0, @anchor-lang/core 1.2.0 |
| Legacy Solana TypeScript clients | @solana/web3.js 1.98.4, @solana/spl-token 0.4.14 |
| EVM client / TypeScript | ethers 6.16.0 / TypeScript 5.9.3 |

The Anchor/Solana pair matches the
[official recommendation](https://www.anchor-lang.com/docs/updates/release-notes/1-2-0);
its [TypeScript client](https://www.anchor-lang.com/docs/clients/typescript)
uses legacy web3.js v1. Host Rust and the SBF compiler are distinct. Exact direct
pins and dependency graphs are retained in the toolchain configuration,
Cargo.lock, package.json, and package-lock.json.

Verified: Forge compilation/formatting, locked host Rust check/formatting,
Anchor SBF build and IDL generation with zero business instructions, TypeScript
full typecheck/client imports, and isolated local RPC health/version checks.
Solana returned health `ok` and version `4.1.2`; Anvil returned chain ID
`0x7a69` (31337) and block `0x0`. These establish scaffold/tool compatibility,
not application correctness, protocol invariants, or cross-chain integration.

Remaining setup choices: actual deployment keys/addresses/domain bytes, fixture
cash supply and executor liquidity, and the harness-only demo timeout value.
These choices must preserve the economic flow, trust assumptions, encoding,
state transitions, and refund rules.
