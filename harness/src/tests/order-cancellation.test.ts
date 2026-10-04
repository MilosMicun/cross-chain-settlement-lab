import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
  unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
assert.ok(runtime, "Use scripts/check-solana-cancellation.sh with a fresh local validator");
const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(join(runtime, "deployment-authority.json"), "utf8"),
)));
let feePayer = faucet;
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const provider = new AnchorProvider(connection, new Wallet(faucet), { commitment: "finalized" });
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, provider);
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
assert.ok(program.programId.equals(programId));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
const eventParser = new EventParser(programId, program.coder);
const tracked = new Map<string, PublicKey>();
let latestSlot = 0;
const evidence: { name: string; signature: string; error: unknown; events: number }[] = [];
const bn = (value: bigint) => new BN(value.toString());
const u64be = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
function track(...keys: PublicKey[]) { for (const key of keys) tracked.set(key.toBase58(), key); }

async function info(key: PublicKey) {
  return connection.getAccountInfo(key, { commitment: "finalized", minContextSlot: latestSlot });
}
async function snapshot() {
  const keys = [...tracked.values()];
  const accounts = await connection.getMultipleAccountsInfo(keys, { commitment: "finalized", minContextSlot: latestSlot });
  return accounts.map((account, index) => ({ key: keys[index].toBase58(), account: account && {
    owner: account.owner.toBase58(), data: account.data.toString("hex"),
    lamports: account.lamports, executable: account.executable,
  } }));
}

async function submit(instructions: TransactionInstruction[], signers: Keypair[] = []) {
  const feePayerBefore = (await info(feePayer.publicKey))!.lamports;
  const block = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({ ...block, feePayer: feePayer.publicKey }).add(...instructions);
  const required = [feePayer, ...signers];
  if (instructions.some((ix) => ix.keys.some((meta) => meta.isSigner && meta.pubkey.equals(faucet.publicKey)))) {
    required.push(faucet);
  }
  transaction.sign(...[...new Map(required.map((key) => [key.publicKey.toBase58(), key])).values()]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
  const deadline = Date.now() + 90_000;
  let status;
  while (Date.now() < deadline) {
    status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.confirmationStatus === "finalized") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.confirmationStatus, "finalized", `Finalization deadline exceeded: ${signature}`);
  const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  assert.ok(receipt?.meta);
  assert.deepEqual(receipt.meta.err, status.err);
  latestSlot = Math.max(latestSlot, receipt.slot);
  const events = [...eventParser.parseLogs(receipt.meta.logMessages ?? [])];
  return { signature, receipt, events, feePayerBefore, feePayerAfter: (await info(feePayer.publicKey))!.lamports };
}
async function setup(instructions: TransactionInstruction[], signers: Keypair[] = []) {
  const beforeAccounting = await info(accounting);
  const result = await submit(instructions, signers);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
  assert.deepEqual(await info(accounting), beforeAccounting, "Faucet minting, donations, and fixture operations preserve Accounting");
}

// Totals are bigint throughout; expected increments come only from successful
// creation inputs, never from Accounting, token balances, or creation events.
let expectedDeposits = 0n;
let startingDeposits = 0n;
const donations = new Map<string, bigint>();
const u128le = (value: bigint) => {
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes;
};
async function permanentOrders() {
  return program.account.order.all([{ memcmp: { offset: 8, bytes: config.toBase58() } }]);
}
async function orderDepositSum() {
  return (await permanentOrders()).reduce((sum, { account }) => sum + BigInt(account.cashAmount.toString()), 0n);
}
async function verifyAccounting() {
  const ledger = await info(accounting); assert.ok(ledger);
  assert.ok(ledger.owner.equals(programId)); assert.equal(ledger.executable, false);
  const expected = Buffer.concat([sha(Buffer.from("account:Accounting")).subarray(0, 8),
    config.toBuffer(), u128le(expectedDeposits), Buffer.alloc(48), Buffer.from([accountingBump])]);
  assert.equal(ledger.data.length, 105);
  assert.deepEqual(ledger.data, expected, "Exact cumulative deposits; every other accounting byte stays unchanged");
  assert.equal(ledger.lamports, await connection.getMinimumBalanceForRentExemption(105, "finalized"));
}
async function reconcileLockedCash() {
  assert.equal(await orderDepositSum(), expectedDeposits, "Deposits equal all permanent Config order cash amounts");
  await verifyAccounting();
  for (const { account } of await permanentOrders()) {
    assert.equal(await tokenAmount(account.escrow), BigInt(account.cashAmount.toString()) +
      (donations.get(account.escrow.toBase58()) ?? 0n), "Each deposit stays locked; known donations are separate");
  }
}

let c: Awaited<ReturnType<typeof program.account.config.fetch>>;
type User = { key: Keypair; cash: PublicKey; yes: PublicKey };
type Terms = { nonce: bigint; cash: bigint; minimum: bigint };
type Bindings = {
  user: PublicKey; config: PublicKey; accounting: PublicKey; userNonce: PublicKey; order: PublicKey;
  cashMint: PublicKey; yesMint: PublicKey; userCashAta: PublicKey; userYesAta: PublicKey;
  escrow: PublicKey; tokenProgram: PublicKey; associatedTokenProgram: PublicKey; systemProgram: PublicKey;
};
function bindings(user: User, nonce: bigint): Bindings {
  const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.key.publicKey.toBuffer()], programId);
  const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.key.publicKey.toBuffer(), u64be(nonce)], programId);
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  track(userNonce, order, escrow);
  return { user: user.key.publicKey, config, accounting, userNonce, order, cashMint: c.cashMint,
    yesMint: c.yesMint, userCashAta: user.cash, userYesAta: user.yes, escrow,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId };
}
async function instruction(user: User, terms: Terms, changes: Partial<Bindings> = {}) {
  return program.methods.createOrder({ nonce: bn(terms.nonce), cashAmount: bn(terms.cash),
    minimumShares: bn(terms.minimum) }).accountsStrict({ ...bindings(user, terms.nonce), ...changes }).instruction();
}
async function tokenAmount(key: PublicKey) {
  const account = await info(key); assert.ok(account);
  return unpackAccount(key, account).amount;
}
async function userFixture(cash: bigint): Promise<User> {
  const key = Keypair.generate();
  const user = { key, cash: getAssociatedTokenAddressSync(c.cashMint, key.publicKey),
    yes: getAssociatedTokenAddressSync(c.yesMint, key.publicKey) };
  await setup([
    SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: key.publicKey, lamports: 1_000_000_000 }),
    createAssociatedTokenAccountInstruction(faucet.publicKey, user.cash, key.publicKey, c.cashMint),
    createAssociatedTokenAccountInstruction(faucet.publicKey, user.yes, key.publicKey, c.yesMint),
    createMintToInstruction(c.cashMint, user.cash, faucet.publicKey, cash),
  ]);
  track(key.publicKey, user.cash, user.yes);
  return user;
}
// Independent SPEC fixed-width encoding, without the production Rust helper.
function hashes(user: User, terms: Terms) {
  const domain = Buffer.concat([Buffer.from(c.sourceDomain), Buffer.from(c.destinationDomain),
    programId.toBuffer(), Buffer.from(c.chainId), Buffer.from(c.settlement)]);
  assert.equal(domain.length, 148);
  const identity = Buffer.concat([Buffer.from("CCSLID01"), domain, user.key.publicKey.toBuffer(), u64be(terms.nonce)]);
  assert.equal(identity.length, 196);
  const orderId = sha(identity);
  const encodedTerms = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.key.publicKey.toBuffer(),
    u64be(terms.nonce), Buffer.from(c.market), Buffer.from([c.outcome]), u64be(terms.cash), u64be(terms.minimum)]);
  assert.equal(encodedTerms.length, 277);
  return { orderId, termsHash: sha(encodedTerms) };
}


type CancelAccounts = { user: PublicKey; config: PublicKey; order: PublicKey };
async function cancelInstruction(user: User, terms: Terms, changes: Partial<CancelAccounts> = {},
  expectedHash: Buffer = hashes(user, terms).termsHash) {
  const ix = await program.methods.requestCancel(bn(terms.nonce), [...expectedHash]).accountsStrict({
    user: user.key.publicKey, config, order: bindings(user, terms.nonce).order, ...changes,
  }).instruction();
  assert.equal(ix.keys.length, 3, "Only original user, read-only Config, and writable existing Order");
  assert.equal(ix.keys[0].isSigner, true); assert.equal(ix.keys[0].isWritable, false);
  assert.equal(ix.keys[1].isWritable, false); assert.equal(ix.keys[2].isWritable, true);
  return ix;
}
function noCpi(result: Awaited<ReturnType<typeof submit>>) {
  const logs = result.receipt.meta!.logMessages ?? [];
  assert.ok(!logs.some((line) => line.startsWith(`Program ${TOKEN_PROGRAM_ID} invoke`)));
  assert.ok(!logs.some((line) => line.startsWith(`Program ${SystemProgram.programId} invoke`)));
  assert.ok(!logs.some((line) => /invoke \[[2-9]/.test(line)), "No nested program invocation");
  assert.equal(result.receipt.meta!.innerInstructions?.length ?? 0, 0);
  assert.ok(Number.isSafeInteger(result.feePayerBefore) && Number.isSafeInteger(result.feePayerAfter));
  assert.equal(result.feePayerAfter, result.feePayerBefore - result.receipt.meta!.fee,
    "Separate funded fee payer pays only the transaction fee");
}
function record(name: string, result: Awaited<ReturnType<typeof submit>>) {
  evidence.push({ name, signature: result.signature, error: result.receipt.meta!.err, events: result.events.length });
}
async function create(user: User, terms: Terms) {
  const a = bindings(user, terms.nonce);
  await verifyAccounting();
  const beforeAccounting = await info(accounting); assert.ok(beforeAccounting);
  const beforeCash = await tokenAmount(user.cash);
  const result = await submit([await instruction(user, terms)], [user.key]);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
  expectedDeposits += terms.cash;
  await verifyAccounting();
  const expectedAccounting = Buffer.from(beforeAccounting.data);
  u128le(expectedDeposits).copy(expectedAccounting, 40);
  assert.deepEqual(await info(accounting), { ...beforeAccounting, data: expectedAccounting }, "NEW creation changes only deposits once");
  assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "orderCreated");
  assert.equal(await tokenAmount(user.cash), beforeCash - terms.cash);
  assert.equal(await tokenAmount(a.escrow), terms.cash);
  assert.equal(String((await program.account.userNonce.fetch(a.userNonce, "finalized")).nextNonce), String(terms.nonce + 1n));
  const order = await program.account.order.fetch(a.order, "finalized");
  assert.deepEqual(order.state, { pending: {} }); assert.equal(order.cancellationRequested, false);
  assert.deepEqual(order.orderId, [...hashes(user, terms).orderId]);
  assert.deepEqual(order.termsHash, [...hashes(user, terms).termsHash]);
  record("create fixture", result);
  return a;
}
async function request(name: string, user: User, terms: Terms, firstRequest: boolean) {
  const a = bindings(user, terms.nonce);
  const before = await snapshot();
  const beforeOrder = await program.account.order.fetch(a.order, "finalized");
  const result = await submit([await cancelInstruction(user, terms)], [user.key]);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
  noCpi(result);
  assert.equal(result.events.length, firstRequest ? 1 : 0);
  const expected = structuredClone(before);
  if (firstRequest) {
    const entry = expected.find((entry) => entry.key === a.order.toBase58()); assert.ok(entry?.account);
    const data = Buffer.from(entry.account.data, "hex");
    // Independent fixed-width Order layout: state and flag follow the three stored addresses.
    const stateOffset = 8 + 32 + 32 + 8 + 32 + 1 + 8 + 8 + 32 + 32 + 32 + 32 + 32;
    assert.equal(data[stateOffset], 0); assert.equal(data[stateOffset + 1], 0);
    data[stateOffset] = 1; data[stateOffset + 1] = 1;
    entry.account.data = data.toString("hex");
    assert.equal(result.events[0].name, "cancellationRequested");
    const event = result.events[0].data as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), ["config", "user", "order", "nonce", "orderId", "termsHash"].sort());
    for (const [field, value] of Object.entries({ config, user: user.key.publicKey, order: a.order })) {
      assert.ok(event[field] instanceof PublicKey && event[field].equals(value));
    }
    assert.equal(String(event.nonce), String(terms.nonce));
    assert.deepEqual(event.orderId, beforeOrder.orderId); assert.deepEqual(event.termsHash, beforeOrder.termsHash);
  }
  assert.deepEqual(await snapshot(), expected, "Only accepted first request may change Order state/flag; all rent, balances, supplies, nonce and other accounts remain exact");
  const afterOrder = await program.account.order.fetch(a.order, "finalized");
  assert.deepEqual(afterOrder, { ...beforeOrder, state: { cancelRequested: {} }, cancellationRequested: true });
  assert.equal(afterOrder.acceptedReceipt, null);
  record(name, result);
}
async function reject(name: string, expected: string, user: User, terms: Terms,
  changes: Partial<CancelAccounts> = {}, missingSignature = false, expectedHash?: Buffer) {
  const ix = await cancelInstruction(user, terms, changes, expectedHash);
  track(...Object.values(changes));
  if (missingSignature) ix.keys[0].isSigner = false;
  const before = await snapshot();
  const result = await submit([ix], missingSignature ? [] : [user.key]);
  assert.notEqual(result.receipt.meta!.err, null);
  const logs = result.receipt.meta!.logMessages ?? [];
  assert.ok(logs.includes(`Program ${programId} invoke [1]`), "Application must actually execute");
  assert.ok(logs.some((line) => line.includes(expected)), `${name}: expected ${expected}; ${JSON.stringify(logs)}`);
  assert.equal((result.receipt.meta!.err as { InstructionError?: [number, unknown] }).InstructionError?.[0], 0);
  assert.equal(result.events.length, 0); noCpi(result);
  assert.deepEqual(await snapshot(), before, "Finalized failure preserves account existence, data, balances, supplies, rent, and nonce");
  record(name, result);
}
async function creationReplay(user: User, terms: Terms) {
  const before = await snapshot();
  const result = await submit([await instruction(user, terms)], [user.key]);
  assert.equal(result.receipt.meta!.err, null); assert.equal(result.events.length, 0); noCpi(result);
  assert.deepEqual(await snapshot(), before, "Creation replay retains cancellation and never redeposits or advances nonce");
  record("creation replay after cancellation", result);
}
const first = { nonce: 0n, cash: 10_000_000n, minimum: 20_000_000n };
const second = { ...first, nonce: 1n };
const third = { ...first, nonce: 2n };
let alice: User; let bob: User; let empty: User; let detached: User;
let a: Bindings; let b: Bindings;

test("actual SBF user cancellation intent without payout", { timeout: 850_000 }, async (t) => {
  await t.test("genuine immutable deployment and fresh signed users with actual deposits", async () => {
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
    assert.equal((await info(programData))!.data[12], 0);
    // Genesis faucet lamports exceed JS safe integers. Keep fee accounting on a
    // separate fresh signer with an exactly representable, modest SOL balance.
    const payer = Keypair.generate();
    await setup([SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: payer.publicKey, lamports: 10_000_000_000 })]);
    feePayer = payer;
    c = await program.account.config.fetch(config, "finalized");
    startingDeposits = await orderDepositSum();
    expectedDeposits = startingDeposits;
    await verifyAccounting();
    const priorEvidence = JSON.parse(readFileSync(join(runtime, "orders-evidence.json"), "utf8")) as { donations: [string, string][] };
    for (const [escrow, amount] of priorEvidence.donations) donations.set(escrow, BigInt(amount));
    await reconcileLockedCash();
    track(config, accounting, c.cashMint, c.yesMint, c.executorCashAta, programData, programId);
    alice = await userFixture(30_000_000n); bob = await userFixture(10_000_000n);
    empty = await userFixture(10_000_000n); detached = await userFixture(10_000_000n);
    a = await create(alice, first); b = await create(bob, first);
    await create(alice, second);
  });
  await t.test("first cancellation after nonce advancement changes only state/flag with one event", () => request("first request after advanced nonce", alice, first, true));
  await t.test("duplicate cancellation preserves every byte without event or CPI", () => request("duplicate cancellation", alice, first, false));
  await t.test("another user's order stays Pending and its escrow remains intact", async () => {
    assert.deepEqual((await program.account.order.fetch(b.order, "finalized")).state, { pending: {} });
    assert.equal(await tokenAmount(b.escrow), first.cash);
  });
  await t.test("creation replay after cancellation keeps flag, locked cash, and nonce", () => creationReplay(alice, first));
  await t.test("subsequent creation succeeds and preserves cancelled order and escrow", async () => {
    const beforeOrder = await info(a.order); const beforeEscrow = await info(a.escrow);
    await create(alice, third);
    assert.deepEqual(await info(a.order), beforeOrder); assert.deepEqual(await info(a.escrow), beforeEscrow);
  });
  await t.test("replay succeeds with no remaining user cash", async () => {
    assert.equal(await tokenAmount(alice.cash), 0n);
    await request("zero cash cancellation replay", alice, first, false);
  });
  await t.test("first request succeeds with zero user cash", async () => {
    await create(empty, first); assert.equal(await tokenAmount(empty.cash), 0n);
    await request("zero cash first request", empty, first, true);
  });
  await t.test("cancellation needs no live user cash or YES ATA", async () => {
    await create(detached, first);
    await setup([
      createCloseAccountInstruction(detached.cash, faucet.publicKey, detached.key.publicKey),
      createCloseAccountInstruction(detached.yes, faucet.publicKey, detached.key.publicKey),
    ], [detached.key]);
    assert.equal(await info(detached.cash), null); assert.equal(await info(detached.yes), null);
    await request("absent user ATAs", detached, first, true);
    await request("absent user ATAs replay", detached, first, false);
  });
  await t.test("missing original signature rejects a Pending request", () => reject("missing original signature", "AccountNotSigner", alice, second, {}, true));
  await t.test("replay still requires original signature", () => reject("unsigned cancellation replay", "AccountNotSigner", alice, first, {}, true));
  await t.test("another signer cannot cancel original order", () => reject("wrong signed user", "ConstraintSeeds", bob, first, { order: a.order }));
  await t.test("deployment authority cannot replace original user", () => reject("authority substitution", "ConstraintSeeds", { ...alice, key: faucet }, first, { order: a.order }));
  await t.test("operator cannot cancel without original signature", () => reject("operator substitution", "AccountNotSigner", alice, first, { user: c.solanaOperator }, true));
  await t.test("executor cannot cancel without original signature", () => reject("executor substitution", "AccountNotSigner", alice, first, { user: c.solanaExecutor }, true));
  await t.test("wrong nonce with existing original Order fails", () => reject("wrong nonce", "ConstraintSeeds", alice, second, { order: a.order }));
  await t.test("another user's Order PDA fails", () => reject("wrong order PDA", "ConstraintSeeds", alice, first, { order: b.order }));
  await t.test("wrong Order owner fails", () => reject("wrong order owner", "AccountOwnedByWrongProgram", alice, first, { order: c.cashMint }));
  await t.test("wrong Order discriminator fails", () => reject("wrong order type", "AccountDiscriminatorMismatch", alice, first, { order: config }));
  await t.test("wrong Config discriminator fails", () => reject("wrong config type", "AccountDiscriminatorMismatch", alice, first, { config: a.order }));
  await t.test("wrong Config owner fails", () => reject("wrong config owner", "AccountOwnedByWrongProgram", alice, first, { config: c.cashMint }));
  await t.test("wrong Config address fails without allocation", () => reject("nonexistent config", "AccountNotInitialized", alice, first, { config: Keypair.generate().publicKey }));
  await t.test("wrong expected terms hash rejects Pending order", () => reject("wrong pending hash", "CancellationTermsConflict", alice, second, {}, false, Buffer.alloc(32)));
  await t.test("wrong expected terms hash rejects cancellation replay", () => reject("wrong replay hash", "CancellationTermsConflict", alice, first, {}, false, Buffer.alloc(32)));
  await t.test("nonexistent canonical order fails without rent allocation or nonce change", async () => {
    const absent = bindings(alice, 3n);
    assert.equal(await info(absent.order), null); assert.equal(await info(absent.escrow), null);
    await reject("nonexistent order", "AccountNotInitialized", alice, { ...first, nonce: 3n });
    assert.equal(await info(absent.order), null); assert.equal(await info(absent.escrow), null);
  });
  await t.test("donated escrow remains locked through first cancellation and replay", async () => {
    const pending = bindings(alice, second.nonce);
    await setup([createMintToInstruction(c.cashMint, bob.cash, faucet.publicKey, 7n)]);
    await setup([createTransferCheckedInstruction(bob.cash, c.cashMint, pending.escrow, bob.key.publicKey, 7n, 6)], [bob.key]);
    donations.set(pending.escrow.toBase58(), 7n);
    await verifyAccounting();
    assert.equal(await tokenAmount(pending.escrow), second.cash + 7n);
    await request("donated escrow first cancellation", alice, second, true);
    await request("donated escrow duplicate", alice, second, false);
    await creationReplay(alice, second);
    assert.equal(await tokenAmount(pending.escrow), second.cash + 7n);
  });
  await t.test("reconcile all deposits and locked cash; terminal replay remains host-only", async () => {
    await reconcileLockedCash();
    assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, 0n);
    assert.equal(String((await program.account.userNonce.fetch(a.userNonce, "finalized")).nextNonce), "3");
    assert.equal(await tokenAmount(a.escrow), first.cash);
    writeFileSync(join(runtime, "cancellation-evidence.json"), JSON.stringify({
      accounting: accounting.toBase58(), accountingSpace: 105,
      startingDeposits: startingDeposits.toString(), totalDeposited: expectedDeposits.toString(),
      totalRefunded: "0", totalReimbursed: "0", totalSharesMinted: "0",
      permanentOrderCount: (await permanentOrders()).length,
      donations: [...donations].map(([escrow, amount]) => [escrow, amount.toString()]),
      programId: programId.toBase58(), upgradeAuthority: null, terminalReplay: "host fixtures only",
      finalizedRejectedTransactions: evidence.filter((entry) => entry.error !== null).length,
      cancellationRequests: evidence.filter((entry) => entry.events === 1 && entry.name !== "create fixture").length,
      successfulCreations: evidence.filter((entry) => entry.name === "create fixture").length,
      successfulReplays: evidence.filter((entry) => entry.error === null && entry.events === 0).length,
      transactions: evidence,
    }, null, 2) + "\n");
  });
});
