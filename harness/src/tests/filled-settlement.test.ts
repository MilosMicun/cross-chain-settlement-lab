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
  createBurnCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
  unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
assert.ok(runtime, "Use scripts/check-solana-filled.sh with a fresh local validator");
const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(join(runtime, "deployment-authority.json"), "utf8"),
)));
const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(join(runtime, "operator-fixture.json"), "utf8"),
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
const evidence: { name: string; signature: string; error: unknown; events: number; slot: number; confirmationStatus: "finalized" }[] = [];
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


const u128le = (value: bigint) => {
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  bytes.writeBigUInt64LE(value >> 64n, 8);
  return bytes;
};
let expectedDeposits = 0n;
let expectedReimbursed = 0n;
let expectedMinted = 0n;
let burned = 0n;
let startingDeposits = 0n;
const donations = new Map<string, bigint>();
const burns: { user: string; quantity: string; signature: string }[] = [];
const maxU64 = (1n << 64n) - 1n;

async function verifyAccounting() {
  const raw = await info(accounting); assert.ok(raw);
  const expected = Buffer.concat([sha(Buffer.from("account:Accounting")).subarray(0, 8), config.toBuffer(),
    u128le(expectedDeposits), u128le(0n), u128le(expectedReimbursed), u128le(expectedMinted), Buffer.from([accountingBump])]);
  assert.equal(raw.data.length, 105); assert.deepEqual(raw.data, expected);
  assert.ok(raw.owner.equals(programId));
  assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, expectedMinted - burned,
    "Current supply equals independently tracked issuance minus genuine user burns");
}
function record(name: string, result: Awaited<ReturnType<typeof submit>>) {
  evidence.push({ name, signature: result.signature, error: result.receipt.meta!.err, events: result.events.length,
    slot: result.receipt.slot, confirmationStatus: "finalized" });
}
function success(result: Awaited<ReturnType<typeof submit>>) {
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
}
function noCpi(result: Awaited<ReturnType<typeof submit>>) {
  assert.equal(result.receipt.meta!.innerInstructions?.length ?? 0, 0);
  assert.ok(!(result.receipt.meta!.logMessages ?? []).some((line) => /invoke \[[2-9]/.test(line)));
  assert.equal(result.feePayerAfter, result.feePayerBefore - result.receipt.meta!.fee);
}
function filledArgs(user: User, terms: Terms) {
  return {
    terms: { domain: { sourceDomain: c.sourceDomain, destinationDomain: c.destinationDomain,
      solanaProgram: programId, chainId: c.chainId, settlement: c.settlement },
    user: user.key.publicKey, nonce: bn(terms.nonce), market: c.market, outcome: c.outcome,
    cashAmount: bn(terms.cash), minimumShares: bn(terms.minimum) },
    receipt: { termsHash: [...hashes(user, terms).termsHash], terminal: 1, filledQuantity: bn(terms.cash * 2n) },
  };
}
type FilledArgs = ReturnType<typeof filledArgs>;
function filledBindings(user: User, terms: Terms) {
  const a = bindings(user, terms.nonce);
  const [yesAuthority] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
  return { operator: operator.publicKey, user: user.key.publicKey, config, accounting,
    userNonce: a.userNonce, order: a.order, cashMint: c.cashMint, yesMint: c.yesMint,
    userYesAta: user.yes, escrow: a.escrow, executorCashAta: c.executorCashAta,
    yesAuthority, tokenProgram: TOKEN_PROGRAM_ID };
}
type FilledBindings = ReturnType<typeof filledBindings>;
async function fillInstruction(user: User, terms: Terms, changes: Partial<FilledBindings> = {}, args = filledArgs(user, terms)) {
  const ix = await program.methods.acceptFilled(args).accountsStrict({ ...filledBindings(user, terms), ...changes }).instruction();
  assert.equal(ix.keys.length, 13);
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isSigner, false); assert.equal(ix.keys[1].isWritable, false);
  return ix;
}
function receiptHash(user: User, terms: Terms) {
  const preimage = Buffer.concat([Buffer.from("CCSLRC01"), hashes(user, terms).termsHash,
    Buffer.from([1]), u64be(terms.cash * 2n)]);
  assert.equal(preimage.length, 49);
  return sha(preimage);
}
async function cancelInstruction(user: User, terms: Terms) {
  return program.methods.requestCancel(bn(terms.nonce), [...hashes(user, terms).termsHash]).accountsStrict({
    user: user.key.publicKey, config, order: bindings(user, terms.nonce).order,
  }).instruction();
}
async function create(user: User, terms: Terms) {
  const a = bindings(user, terms.nonce);
  const beforeLedger = await info(accounting); assert.ok(beforeLedger);
  const beforeCash = await tokenAmount(user.cash);
  const result = await submit([await instruction(user, terms)], [user.key]); success(result);
  expectedDeposits += terms.cash;
  const expected = Buffer.from(beforeLedger.data); u128le(expectedDeposits).copy(expected, 40);
  assert.deepEqual(await info(accounting), { ...beforeLedger, data: expected });
  assert.equal(await tokenAmount(user.cash), beforeCash - terms.cash);
  assert.equal(await tokenAmount(a.escrow), terms.cash);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "orderCreated");
  const order = await program.account.order.fetch(a.order, "finalized");
  assert.deepEqual(order.state, { pending: {} }); assert.equal(order.acceptedReceipt, null);
  assert.equal(order.cancellationRequested, false);
  assert.deepEqual(order.orderId, [...hashes(user, terms).orderId]);
  assert.deepEqual(order.termsHash, [...hashes(user, terms).termsHash]);
  assert.equal(String((await program.account.userNonce.fetch(a.userNonce, "finalized")).nextNonce), String(terms.nonce + 1n));
  await verifyAccounting(); record("create fixture", result);
  return a;
}

async function accept(name: string, user: User, terms: Terms) {
  const a = bindings(user, terms.nonce);
  const before = await snapshot();
  const beforeOrder = await program.account.order.fetch(a.order, "finalized");
  const result = await submit([await fillInstruction(user, terms)], [operator]); success(result);
  expectedReimbursed += terms.cash; expectedMinted += terms.cash * 2n;
  assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "filledAccepted");
  const event = result.events[0].data as Record<string, unknown>;
  assert.deepEqual(Object.keys(event).sort(), ["order", "termsHash", "receiptHash", "cashAmount", "filledQuantity"].sort());
  assert.ok(event.order instanceof PublicKey && event.order.equals(a.order));
  assert.deepEqual(event.termsHash, [...hashes(user, terms).termsHash]);
  assert.deepEqual(event.receiptHash, [...receiptHash(user, terms)]);
  assert.equal(String(event.cashAmount), String(terms.cash));
  assert.equal(String(event.filledQuantity), String(terms.cash * 2n));
  const inner = result.receipt.meta!.innerInstructions; assert.equal(inner?.length, 1);
  assert.equal(inner![0].instructions.length, 2);
  const mintCpi = inner![0].instructions[0]; const transferCpi = inner![0].instructions[1];
  const checkedData = (tag: number, amount: bigint) => {
    const bytes = Buffer.alloc(10); bytes[0] = tag; bytes.writeBigUInt64LE(amount, 1); bytes[9] = 6; return bytes;
  };
  // Authenticate the actual CPI instruction bytes and account order rather than
  // relying on optional SPL program log labels in the local validator version.
  assert.deepEqual(Buffer.from(anchor.utils.bytes.bs58.decode(mintCpi.data)), checkedData(14, terms.cash * 2n));
  assert.deepEqual(Buffer.from(anchor.utils.bytes.bs58.decode(transferCpi.data)), checkedData(12, terms.cash));
  for (const [ix, expectedKeys] of [[mintCpi, [c.yesMint, user.yes, filledBindings(user, terms).yesAuthority]],
    [transferCpi, [a.escrow, c.cashMint, c.executorCashAta, a.order]]] as const) {
    assert.ok(result.receipt.transaction.message.staticAccountKeys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID));
    assert.deepEqual(ix.accounts.map((index) => result.receipt.transaction.message.staticAccountKeys[index].toBase58()),
      expectedKeys.map((key) => key.toBase58()));
  }
  assert.ok(!result.receipt.transaction.message.staticAccountKeys.some((key, index) =>
    key.equals(user.key.publicKey) && result.receipt.transaction.message.isAccountSigner(index)), "Original user never signs Filled delivery");

  const expected = structuredClone(before);
  function edit(key: PublicKey, change: (data: Buffer) => void) {
    const entry = expected.find((entry) => entry.key === key.toBase58()); assert.ok(entry?.account);
    const data = Buffer.from(entry.account.data, "hex"); change(data); entry.account.data = data.toString("hex");
  }
  edit(accounting, (data) => { u128le(expectedReimbursed).copy(data, 72); u128le(expectedMinted).copy(data, 88); });
  edit(user.yes, (data) => data.writeBigUInt64LE(data.readBigUInt64LE(64) + terms.cash * 2n, 64));
  edit(c.yesMint, (data) => data.writeBigUInt64LE(data.readBigUInt64LE(36) + terms.cash * 2n, 36));
  edit(a.escrow, (data) => data.writeBigUInt64LE(data.readBigUInt64LE(64) - terms.cash, 64));
  edit(c.executorCashAta, (data) => data.writeBigUInt64LE(data.readBigUInt64LE(64) + terms.cash, 64));
  edit(a.order, (data) => {
    assert.equal(data.length, 335); assert.equal(data[291], 0);
    const bumps = data.subarray(292, 294); const savedBumps = Buffer.from(bumps);
    data[289] = 2; data[291] = 1; data[292] = 1;
    data.writeBigUInt64LE(terms.cash * 2n, 293); receiptHash(user, terms).copy(data, 301);
    savedBumps.copy(data, 333);
  });
  assert.deepEqual(await snapshot(), expected,
    "Only exact payout/issuance deltas, reimbursement/minted counters, and settled receipt bytes change");
  const order = await program.account.order.fetch(a.order, "finalized");
  const { acceptedReceipt, ...immutableAfter } = order;
  const { acceptedReceipt: previousReceipt, ...immutableBefore } = beforeOrder;
  assert.equal(previousReceipt, null);
  assert.deepEqual(immutableAfter, { ...immutableBefore, state: { settled: {} } });
  assert.ok(acceptedReceipt); assert.equal(acceptedReceipt.terminal, 1);
  assert.equal(String(acceptedReceipt.filledQuantity), String(terms.cash * 2n));
  assert.deepEqual(acceptedReceipt.receiptHash, [...receiptHash(user, terms)]);
  await verifyAccounting(); record(name, result);
}
async function unchanged(name: string, ix: TransactionInstruction, signers: Keypair[], expectedError?: string, mintFailure = false) {
  const before = await snapshot();
  const result = await submit([ix], signers);
  if (expectedError) {
    assert.notEqual(result.receipt.meta!.err, null);
    const logs = result.receipt.meta!.logMessages ?? [];
    assert.ok(logs.includes(`Program ${programId} invoke [1]`), "Rejection must execute the actual SBF program");
    assert.ok(logs.some((line) => line.includes(expectedError)), `${name}: ${JSON.stringify(logs)}`);
    assert.equal((result.receipt.meta!.err as { InstructionError?: [number, unknown] }).InstructionError?.[0], 0);
    if (mintFailure) {
      assert.ok(logs.some((line) => line === `Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0xe`), JSON.stringify(logs));
      assert.deepEqual((result.receipt.meta!.err as { InstructionError: [number, unknown] }).InstructionError[1], { Custom: 14 });
      const inner = result.receipt.meta!.innerInstructions; assert.equal(inner?.length, 1);
      assert.equal(inner![0].instructions.length, 1, "Actual first CPI fails before any reimbursement CPI");
      const mintCpi = inner![0].instructions[0];
      assert.ok(result.receipt.transaction.message.staticAccountKeys[mintCpi.programIdIndex].equals(TOKEN_PROGRAM_ID));
      assert.deepEqual(Buffer.from(anchor.utils.bytes.bs58.decode(mintCpi.data)),
        Buffer.from([14, 2, 0, 0, 0, 0, 0, 0, 0, 6]), "Actual two-unit legacy MintToChecked overflow");
    } else noCpi(result);
  } else { success(result); noCpi(result); }
  assert.equal(result.events.length, 0);
  assert.deepEqual(await snapshot(), before, "Complete protocol/token state including cancellation history is preserved");
  await verifyAccounting(); record(name, result);
  return result;
}
async function reject(name: string, user: User, terms: Terms, expected: string,
  changes: Partial<FilledBindings> = {}, alter?: (args: FilledArgs) => void, signer = operator) {
  track(...Object.values(changes));
  const args = filledArgs(user, terms); alter?.(args);
  return unchanged(name, await fillInstruction(user, terms, changes, args), [signer], expected);
}
async function replay(name: string, user: User, terms: Terms) {
  return unchanged(name, await fillInstruction(user, terms), [operator]);
}
async function burn(user: User, quantity: bigint) {
  assert.ok(quantity > 0n);
  const before = await snapshot();
  const result = await submit([createBurnCheckedInstruction(user.yes, c.yesMint, user.key.publicKey, quantity, 6)], [user.key]); success(result);
  burned += quantity;
  const expected = structuredClone(before);
  for (const [key, offset] of [[user.yes, 64], [c.yesMint, 36]] as const) {
    const entry = expected.find((entry) => entry.key === key.toBase58()); assert.ok(entry?.account);
    const data = Buffer.from(entry.account.data, "hex"); data.writeBigUInt64LE(data.readBigUInt64LE(offset) - quantity, offset);
    entry.account.data = data.toString("hex");
  }
  assert.deepEqual(await snapshot(), expected, "Authorized burn changes only current balance/supply, never cumulative issuance");
  await verifyAccounting();
  burns.push({ user: user.key.publicKey.toBase58(), quantity: String(quantity), signature: result.signature });
  record("legitimate user burn", result);
}
async function reconcile() {
  const orders = await program.account.order.all([{ memcmp: { offset: 8, bytes: config.toBase58() } }]);
  let deposits = 0n; let reimbursements = 0n; let minted = 0n;
  for (const { account } of orders) {
    const cash = BigInt(account.cashAmount.toString()); deposits += cash;
    const settled = "settled" in account.state;
    if (settled) { reimbursements += cash; minted += BigInt(account.acceptedReceipt!.filledQuantity.toString()); }
    assert.equal(await tokenAmount(account.escrow), (settled ? 0n : cash) + (donations.get(account.escrow.toBase58()) ?? 0n));
  }
  assert.equal(deposits, expectedDeposits); assert.equal(reimbursements, expectedReimbursed); assert.equal(minted, expectedMinted);
  await verifyAccounting();
  return orders.length;
}

const first: Terms = { nonce: 0n, cash: 10_000_000n, minimum: 20_000_000n };
const second: Terms = { ...first, nonce: 1n };
const donated: Terms = { ...first, nonce: 2n };
let alice: User; let bob: User; let large: User; let boundary: User;

test("actual SBF operator-attested atomic Filled settlement", { timeout: 850_000 }, async (t) => {
  await t.test("immutable deployment, separate fee payer, independent starting totals, and real orders", async () => {
    c = await program.account.config.fetch(config, "finalized");
    assert.ok(operator.publicKey.equals(c.solanaOperator));
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
    assert.equal((await info(programData))!.data[12], 0);
    const payer = Keypair.generate();
    await setup([SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: payer.publicKey, lamports: 10_000_000_000 }),
      SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: operator.publicKey, lamports: 1_000_000 })]);
    feePayer = payer;
    const orders = await program.account.order.all([{ memcmp: { offset: 8, bytes: config.toBase58() } }]);
    assert.ok(orders.every(({ account }) => account.acceptedReceipt === null));
    expectedDeposits = orders.reduce((sum, { account }) => sum + BigInt(account.cashAmount.toString()), 0n);
    startingDeposits = expectedDeposits;
    const prior = JSON.parse(readFileSync(join(runtime, "cancellation-evidence.json"), "utf8")) as { donations: [string, string][] };
    for (const [escrow, quantity] of prior.donations) donations.set(escrow, BigInt(quantity));
    track(config, accounting, c.cashMint, c.yesMint, c.executorCashAta, programData, programId, operator.publicKey);
    for (const { publicKey, account } of orders) {
      track(publicKey, account.escrow, account.user, account.userCashAta, account.userYesAta,
        PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), account.user.toBuffer()], programId)[0]);
    }
    await reconcile();
    alice = await userFixture(30_000_000n); bob = await userFixture(10_000_000n);
    await create(alice, first); await create(alice, second); await create(alice, donated);
    await create(bob, first);
  });
  await t.test("Pending to Settled mints exact YES and reimburses without original user signature", () => accept("Pending fill", alice, first));
  await t.test("CancelRequested to Settled retains user cancellation history", async () => {
    const before = await program.account.order.fetch(bindings(alice, second.nonce).order, "finalized");
    const result = await submit([await cancelInstruction(alice, second)], [alice.key]); success(result); noCpi(result);
    assert.equal(result.events.length, 1); record("prior cancellation request", result);
    assert.deepEqual(await program.account.order.fetch(bindings(alice, second.nonce).order, "finalized"),
      { ...before, state: { cancelRequested: {} }, cancellationRequested: true });
    await accept("cancel-requested fill", alice, second);
  });
  await t.test("exact terminal replay has no token CPI, event, counter, or byte change", async () => {
    await replay("Pending-history fill replay", alice, first);
    await replay("cancel-history fill replay", alice, second);
  });
  await t.test("legitimate user burn followed by replay never reissues YES", async () => {
    await burn(alice, await tokenAmount(alice.yes));
    assert.equal(await tokenAmount(alice.yes), 0n);
    assert.equal(expectedMinted, 40_000_000n);
    await replay("fill replay after complete user burn", alice, first);
  });
  await t.test("escrow donation stays separate from exact reimbursement and all counters", async () => {
    const a = bindings(alice, donated.nonce);
    await setup([createMintToInstruction(c.cashMint, alice.cash, faucet.publicKey, 7n)]);
    await setup([createTransferCheckedInstruction(alice.cash, c.cashMint, a.escrow, alice.key.publicKey, 7n, 6)], [alice.key]);
    donations.set(a.escrow.toBase58(), 7n);
    assert.equal(await tokenAmount(a.escrow), donated.cash + 7n);
    await accept("donated escrow fill", alice, donated);
    assert.equal(await tokenAmount(a.escrow), 7n);
    await replay("donated terminal replay", alice, donated);
  });
  await t.test("terminal creation replay does not deposit or advance nonce", async () => {
    await unchanged("terminal creation replay", await instruction(alice, first), [alice.key]);
    await unchanged("cancel-history terminal creation replay", await instruction(alice, second), [alice.key]);
  });
  await t.test("prior cancellation replays after settlement; first terminal cancellation rejects", async () => {
    await unchanged("terminal prior cancellation replay", await cancelInstruction(alice, second), [alice.key]);
    await unchanged("first terminal cancellation", await cancelInstruction(alice, first), [alice.key], "CancellationTerminalWithoutRequest");
  });
  await t.test("missing operator signature executes and rejects on chain", async () => {
    const ix = await fillInstruction(bob, first); ix.keys[0].isSigner = false;
    await unchanged("missing operator signature", ix, [], "AccountNotSigner");
  });
  await t.test("genuinely signed wrong operator rejects on chain", async () => {
    await reject("signed wrong operator", bob, first, "FilledUnauthorizedOperator", { operator: alice.key.publicKey }, undefined, alice.key);
  });
  const accountCases: [string, string, () => Partial<FilledBindings>][] = [
    ["wrong original user", "ConstraintSeeds", () => ({ user: alice.key.publicKey })],
    ["wrong Order", "ConstraintSeeds", () => ({ order: bindings(alice, 0n).order })],
    ["wrong reimbursement recipient", "FilledInvalidBinding", () => ({ executorCashAta: bob.cash })],
    ["wrong cash mint", "FilledInvalidBinding", () => ({ cashMint: c.yesMint })],
    ["wrong YES mint", "FilledInvalidBinding", () => ({ yesMint: c.cashMint })],
    ["wrong user YES ATA", "FilledInvalidBinding", () => ({ userYesAta: alice.yes })],
    ["wrong token program", "InvalidProgramId", () => ({ tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })],
  ];
  for (const [name, error, changes] of accountCases) {
    await t.test(`${name} preserves complete state`, async () => { await reject(name, bob, first, error, changes()); });
  }
  const inputCases: [string, string, (args: FilledArgs) => void][] = [
    ["changed immutable cash", "FilledTermsConflict", (args) => { args.terms.cashAmount = bn(first.cash + 1n); }],
    ["changed minimum", "FilledTermsConflict", (args) => { args.terms.minimumShares = bn(1n); }],
    ["changed market", "FilledTermsConflict", (args) => { args.terms.market = Array(32).fill(0xaa); }],
    ["changed outcome", "FilledTermsConflict", (args) => { args.terms.outcome = 1; }],
    ["changed supplied user", "FilledTermsConflict", (args) => { args.terms.user = alice.key.publicKey; }],
    ["changed source domain", "FilledTermsConflict", (args) => { args.terms.domain.sourceDomain = Array(32).fill(0xaa); }],
    ["changed destination domain", "FilledTermsConflict", (args) => { args.terms.domain.destinationDomain = Array(32).fill(0xbb); }],
    ["changed source program", "FilledTermsConflict", (args) => { args.terms.domain.solanaProgram = SystemProgram.programId; }],
    ["changed high chain-ID byte", "FilledTermsConflict", (args) => { args.terms.domain.chainId = [...c.chainId]; args.terms.domain.chainId[0] ^= 0x80; }],
    ["changed EVM settlement", "FilledTermsConflict", (args) => { args.terms.domain.settlement = Array(20).fill(0xcc); }],
    ["wrong receipt terms hash", "FilledInvalidReceipt", (args) => { args.receipt.termsHash = Array(32).fill(0); }],
    ["Cancelled receipt tag", "FilledInvalidReceipt", (args) => { args.receipt.terminal = 2; }],
    ["unsupported receipt tag", "FilledInvalidReceipt", (args) => { args.receipt.terminal = 0; }],
    ["wrong fill quantity", "FilledInvalidReceipt", (args) => { args.receipt.filledQuantity = bn(first.cash * 2n - 1n); }],
  ];
  for (const [name, error, alter] of inputCases) {
    await t.test(`${name} preserves complete state`, async () => { await reject(name, bob, first, error, {}, alter); });
  }
  await t.test("conflicting receipt on Settled also preserves every byte", async () => {
    await reject("changed terminal replay quantity", alice, first, "FilledInvalidReceipt", {}, (args) => { args.receipt.filledQuantity = bn(0n); });
  });
  await t.test("unattainable minimum rejects a new Filled receipt", async () => {
    const user = await userFixture(1n); const terms = { nonce: 0n, cash: 1n, minimum: 3n };
    await create(user, terms);
    await reject("minimum not met", user, terms, "FilledInvalidReceipt");
  });
  await t.test("real mint supply overflow rolls back; authorized burn frees capacity for one retry", async () => {
    // Supply is arranged entirely through protocol fills and owner-authorized burns.
    await burn(alice, await tokenAmount(alice.yes));
    assert.equal(expectedMinted, burned); await verifyAccounting();
    const huge: Terms = { nonce: 0n, cash: maxU64 / 2n, minimum: maxU64 - 1n };
    large = await userFixture(huge.cash); await create(large, huge);
    await accept("largest valid fill", large, huge);
    assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, maxU64 - 1n);
    boundary = await userFixture(1n);
    const terms: Terms = { nonce: 0n, cash: 1n, minimum: 2n };
    await create(boundary, terms);
    const cancel = await submit([await cancelInstruction(boundary, terms)], [boundary.key]); success(cancel); record("boundary prior cancellation", cancel);
    const beforeOrder = await program.account.order.fetch(bindings(boundary, 0n).order, "finalized");
    assert.deepEqual(beforeOrder.state, { cancelRequested: {} });
    assert.equal(beforeOrder.cancellationRequested, true);
    await unchanged("actual first-CPI mint overflow", await fillInstruction(boundary, terms), [operator], "custom program error: 0xe", true);
    await burn(large, 2n);
    await accept("mint overflow retry", boundary, terms);
    await replay("mint overflow retry replay", boundary, terms);
    assert.equal(await tokenAmount(boundary.yes), 2n);
    assert.ok(expectedMinted > maxU64, "u128 cumulative issuance exceeds u64 while current supply stays valid");
    assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, maxU64 - 1n);
    const permanentOrderCount = await reconcile();
    writeFileSync(join(runtime, "filled-evidence.json"), JSON.stringify({
      programId: programId.toBase58(), startingDeposits: String(startingDeposits),
      totalDeposited: String(expectedDeposits), totalRefunded: "0", totalReimbursed: String(expectedReimbursed),
      totalSharesMinted: String(expectedMinted), currentSupply: String(expectedMinted - burned),
      totalUserBurned: String(burned), burns, permanentOrderCount,
      donations: [...donations].map(([escrow, quantity]) => [escrow, String(quantity)]),
      finalizedRejectedTransactions: evidence.filter((entry) => entry.error !== null).length,
      successfulFills: evidence.filter((entry) => entry.error === null && entry.events === 1 &&
        ["Pending fill", "cancel-requested fill", "donated escrow fill", "largest valid fill", "mint overflow retry"].includes(entry.name)).length,
      secondCpiFailureVerified: false, transactions: evidence,
    }, null, 2) + "\n");
  });
});
