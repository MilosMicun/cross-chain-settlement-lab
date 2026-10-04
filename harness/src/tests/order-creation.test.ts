import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import {
  ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, MINT_SIZE,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createInitializeAccountInstruction, createInitializeMintInstruction, createMintToInstruction,
  createSetAuthorityInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
  unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
assert.ok(runtime, "Use scripts/check-solana-orders.sh with a fresh local validator");
const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(join(runtime, "deployment-authority.json"), "utf8"),
)));
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const provider = new AnchorProvider(connection, new Wallet(faucet), { commitment: "finalized" });
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, provider);
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
assert.ok(program.programId.equals(programId));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const eventParser = new EventParser(programId, program.coder);
const tracked = new Map<string, PublicKey>();
let latestSlot = 0;
const evidence: { name: string; signature: string; error: unknown; events: number }[] = [];
const bn = (value: bigint) => new BN(value.toString());
const u64be = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; };
const u64le = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const discriminator = (name: string) => sha(Buffer.from(`account:${name}`)).subarray(0, 8);
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
  const block = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({ ...block, feePayer: faucet.publicKey }).add(...instructions);
  transaction.sign(...[...new Map([faucet, ...signers].map((key) => [key.publicKey.toBase58(), key])).values()]);
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
  return { signature, receipt, events };
}
async function setup(instructions: TransactionInstruction[], signers: Keypair[] = []) {
  const result = await submit(instructions, signers);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
}

let c: Awaited<ReturnType<typeof program.account.config.fetch>>;
type User = { key: Keypair; cash: PublicKey; yes: PublicKey };
type Terms = { nonce: bigint; cash: bigint; minimum: bigint };
type Bindings = {
  user: PublicKey; config: PublicKey; userNonce: PublicKey; order: PublicKey;
  cashMint: PublicKey; yesMint: PublicKey; userCashAta: PublicKey; userYesAta: PublicKey;
  escrow: PublicKey; tokenProgram: PublicKey; associatedTokenProgram: PublicKey; systemProgram: PublicKey;
};
function bindings(user: User, nonce: bigint): Bindings {
  const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.key.publicKey.toBuffer()], programId);
  const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.key.publicKey.toBuffer(), u64be(nonce)], programId);
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  track(userNonce, order, escrow);
  return { user: user.key.publicKey, config, userNonce, order, cashMint: c.cashMint,
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
async function rawToken(mint: PublicKey, owner: PublicKey) {
  const key = Keypair.generate();
  await setup([
    SystemProgram.createAccount({ fromPubkey: faucet.publicKey, newAccountPubkey: key.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccountInstruction(key.publicKey, mint, owner),
  ], [key]);
  track(key.publicKey);
  return key.publicKey;
}
async function foreignMint(token2022 = false) {
  const key = Keypair.generate();
  const token = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  await setup([
    SystemProgram.createAccount({ fromPubkey: faucet.publicKey, newAccountPubkey: key.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: token }),
    createInitializeMintInstruction(key.publicKey, 6, faucet.publicKey, null, token),
  ], [key]);
  track(key.publicKey);
  return key.publicKey;
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

async function created(name: string, user: User, terms: Terms, expectedNext: bigint) {
  const a = bindings(user, terms.nonce);
  const beforeCash = await tokenAmount(user.cash);
  const beforeYes = await tokenAmount(user.yes);
  const beforeSupply = (await info(c.cashMint))!.data;
  const beforeYesMint = (await info(c.yesMint))!.data;
  const beforeExecutor = await tokenAmount(c.executorCashAta);
  const beforeConfig = (await info(config))!.data;
  const userSolBefore = (await info(user.key.publicKey))!.lamports;
  assert.equal(await info(a.order), null);
  assert.equal(await info(a.escrow), null);
  const hadCounter = await info(a.userNonce);
  const result = await submit([await instruction(user, terms)], [user.key]);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].name, "orderCreated");
  const { orderId, termsHash } = hashes(user, terms);
  const [, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.key.publicKey.toBuffer(), u64be(terms.nonce)], programId);
  const [, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), a.order.toBuffer()], programId);
  const [, counterBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.key.publicKey.toBuffer()], programId);
  const orderInfo = await info(a.order); assert.ok(orderInfo);
  assert.ok(orderInfo.owner.equals(programId));
  assert.equal(orderInfo.executable, false);
  assert.equal(orderInfo.data.length, 335, "Maximum allocation includes the 41-byte future receipt");
  const serialized = Buffer.concat([discriminator("Order"), config.toBuffer(), user.key.publicKey.toBuffer(),
    u64le(terms.nonce), Buffer.from(c.market), Buffer.from([0]), u64le(terms.cash), u64le(terms.minimum),
    orderId, termsHash, user.cash.toBuffer(), user.yes.toBuffer(), a.escrow.toBuffer(),
    Buffer.from([0, 0, 0, orderBump, escrowBump]), Buffer.alloc(41)]);
  assert.equal(serialized.length, 335);
  assert.deepEqual(orderInfo.data, serialized, "Every stored field and unused receipt capacity");
  const order = await program.account.order.fetch(a.order, "finalized");
  assert.deepEqual(order.state, { pending: {} });
  assert.equal(order.cancellationRequested, false);
  assert.equal(order.acceptedReceipt, null);
  const counter = await info(a.userNonce); assert.ok(counter);
  assert.ok(counter.owner.equals(programId));
  assert.equal(counter.executable, false);
  assert.deepEqual(counter.data, Buffer.concat([discriminator("UserNonce"), config.toBuffer(),
    user.key.publicKey.toBuffer(), u64le(expectedNext), Buffer.from([counterBump])]));
  const escrowInfo = await info(a.escrow); assert.ok(escrowInfo);
  assert.ok(escrowInfo.owner.equals(TOKEN_PROGRAM_ID));
  assert.equal(escrowInfo.data.length, ACCOUNT_SIZE);
  assert.equal(escrowInfo.executable, false);
  const escrow = unpackAccount(a.escrow, escrowInfo);
  assert.ok(escrow.mint.equals(c.cashMint)); assert.ok(escrow.owner.equals(a.order));
  assert.equal(escrow.isInitialized, true); assert.equal(escrow.isFrozen, false);
  assert.equal(escrow.delegate, null); assert.equal(escrow.closeAuthority, null);
  assert.equal(escrow.amount, terms.cash);
  assert.equal(await tokenAmount(user.cash), beforeCash - terms.cash);
  assert.equal(await tokenAmount(user.yes), beforeYes);
  assert.equal(await tokenAmount(c.executorCashAta), beforeExecutor);
  assert.deepEqual((await info(c.cashMint))!.data, beforeSupply);
  assert.deepEqual((await info(c.yesMint))!.data, beforeYesMint);
  assert.deepEqual((await info(config))!.data, beforeConfig);
  for (const account of [orderInfo, counter, escrowInfo]) {
    assert.equal(account.lamports, await connection.getMinimumBalanceForRentExemption(account.data.length, "finalized"));
  }
  const rentPaid = orderInfo.lamports + escrowInfo.lamports + (hadCounter ? 0 : counter.lamports);
  assert.equal((await info(user.key.publicKey))!.lamports, userSolBefore - rentPaid,
    "Original user pays only account rent; separate faucet pays transaction fees");
  const event = result.events[0].data as Record<string, unknown>;
  for (const [field, value] of Object.entries({ config, user: user.key.publicKey, order: a.order,
    userCashAta: user.cash, userYesAta: user.yes, escrow: a.escrow })) {
    assert.ok(event[field] instanceof PublicKey && event[field].equals(value), field);
  }
  assert.equal(String(event.nonce), terms.nonce.toString());
  assert.equal(String(event.cashAmount), terms.cash.toString());
  assert.equal(String(event.minimumShares), terms.minimum.toString());
  assert.deepEqual(event.orderId, [...orderId]); assert.deepEqual(event.termsHash, [...termsHash]);
  assert.deepEqual(event.market, c.market); assert.equal(event.outcome, 0);
  evidence.push({ name, signature: result.signature, error: null, events: 1 });
  return a;
}

async function replay(name: string, user: User, terms: Terms) {
  bindings(user, terms.nonce);
  const before = await snapshot();
  const result = await submit([await instruction(user, terms)], [user.key]);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
  assert.equal(result.events.length, 0, "Replay must not emit another creation event");
  assert.deepEqual(await snapshot(), before, "Replay preserves every account byte, balance, rent, and nonce");
  const logs = result.receipt.meta!.logMessages ?? [];
  assert.ok(!logs.some((line) => line.startsWith(`Program ${TOKEN_PROGRAM_ID} invoke`)), "Replay must not call SPL Token");
  assert.ok(!logs.some((line) => line.startsWith(`Program ${SystemProgram.programId} invoke`)), "Replay must not create accounts");
  evidence.push({ name, signature: result.signature, error: null, events: 0 });
}
async function rejected(name: string, expected: string, user: User, terms: Terms,
  changes: Partial<Bindings> = {}, nonSigning = false) {
  const ix = await instruction(user, terms, changes);
  track(...Object.values(changes).filter((key) => !key.equals(faucet.publicKey)));
  const before = await snapshot();
  if (nonSigning) {
    const meta = ix.keys.find((key) => key.pubkey.equals(user.key.publicKey)); assert.ok(meta);
    meta.isSigner = false;
  }
  const result = await submit([ix], nonSigning ? [] : [user.key]);
  assert.notEqual(result.receipt.meta!.err, null, `${name}: unexpectedly succeeded`);
  const logs = result.receipt.meta!.logMessages ?? [];
  assert.ok(logs.some((line) => line === `Program ${programId} invoke [1]`), `${name}: application was not invoked`);
  assert.ok(logs.some((line) => line.includes(expected)), `${name}: expected ${expected}; ${JSON.stringify(logs)}`);
  const error = result.receipt.meta!.err as { InstructionError?: [number, unknown] };
  assert.equal(error.InstructionError?.[0], 0);
  assert.equal(result.events.length, 0);
  assert.deepEqual(await snapshot(), before, `${name}: failed transaction changed protocol accounts/tokens or user rent`);
  evidence.push({ name, signature: result.signature, error: result.receipt.meta!.err, events: 0 });
}

const first = { nonce: 0n, cash: 10_000_000n, minimum: 20_000_000n };
const second = { nonce: 1n, cash: 10_000_000n, minimum: 20_000_000n };
const next = { nonce: 2n, cash: 1n, minimum: 1n };
let alice: User;
let bob: User;
let poor: User;
let firstBindings: Bindings;

test("actual SBF atomic order creation after upgrade authority removal", { timeout: 850_000 }, async (t) => {
  await t.test("read immutable deployment and prepare signed legacy SPL user fixtures", async () => {
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
    const deployment = await info(programData); assert.ok(deployment);
    assert.equal(deployment.data[12], 0, "Initialization must already have removed upgrade authority");
    c = await program.account.config.fetch(config, "finalized");
    track(config, c.cashMint, c.yesMint, c.executorCashAta);
    assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, 0n);
    alice = await userFixture(20_000_001n);
    bob = await userFixture(10_000_000n);
    poor = await userFixture(0n);
  });
  await t.test("first order: exact fields, maximum space, rent, deposits, hashes, nonce, and one event", async () => {
    firstBindings = await created("first order", alice, first, 1n);
  });
  await t.test("exact immediate replay preserves all data without token CPI", () => replay("immediate replay", alice, first));
  await t.test("second order advances the permanent counter once", async () => { await created("second order", alice, second, 2n); });
  await t.test("first replay after nonce advancement and insufficient remaining cash", async () => {
    assert.equal(await tokenAmount(alice.cash), 1n);
    await replay("older order with insufficient cash", alice, first);
  });
  await t.test("second order replay with insufficient remaining cash", () => replay("second replay", alice, second));
  await t.test("another user starts at zero with distinct identity", async () => {
    const other = await created("other user nonce zero", bob, first, 1n);
    assert.ok(!other.order.equals(firstBindings.order));
    assert.notDeepEqual(hashes(bob, first).orderId, hashes(alice, first).orderId);
  });
  await t.test("changed valid cash produces TermsConflict without mutation", () => rejected(
    "changed cash", "TermsConflict", alice, { ...first, cash: 9_000_000n }));
  await t.test("changed valid minimum produces TermsConflict without mutation", () => rejected(
    "changed minimum", "TermsConflict", alice, { ...first, minimum: 21_000_000n }));
  await t.test("unsolicited escrow donation survives exact replay", async () => {
    await setup([createMintToInstruction(c.cashMint, poor.cash, faucet.publicKey, 7n)]);
    const userBefore = await tokenAmount(poor.cash);
    const supplyBefore = (await info(c.cashMint))!.data;
    const orderBefore = (await info(firstBindings.order))!.data;
    await setup([createTransferCheckedInstruction(poor.cash, c.cashMint, firstBindings.escrow, poor.key.publicKey, 7n, 6)], [poor.key]);
    assert.equal(await tokenAmount(poor.cash), userBefore - 7n);
    assert.equal(await tokenAmount(firstBindings.escrow), first.cash + 7n);
    assert.deepEqual((await info(c.cashMint))!.data, supplyBefore);
    assert.deepEqual((await info(firstBindings.order))!.data, orderBefore);
    await replay("donated escrow replay", alice, first);
    assert.equal(await tokenAmount(firstBindings.escrow), first.cash + 7n);
  });
  const boundaries: [string, string, Terms][] = [
    ["zero cash", "ZeroCash", { ...next, cash: 0n }],
    ["zero minimum", "ZeroMinimum", { ...next, minimum: 0n }],
    ["cash above half uint64 maximum", "CashTooLarge", { ...next, cash: 1n << 63n }],
    ["maximum uint64 cash", "CashTooLarge", { ...next, cash: (1n << 64n) - 1n }],
    ["skipped nonce", "NonceMismatch", { ...next, nonce: 3n }],
  ];
  for (const [name, expected, terms] of boundaries) {
    await t.test(`reject ${name}`, () => rejected(name, expected, alice, terms));
  }
  await t.test("missing original-user signature with separate fee payer", () => rejected(
    "missing user signature", "AccountNotSigner", alice, next, {}, true));
  await t.test("replay still requires original-user signature", () => rejected(
    "non-signing replay", "AccountNotSigner", alice, first, {}, true));
  await t.test("wrong Config discriminator", () => rejected("wrong Config type", "AccountDiscriminatorMismatch", alice, next,
    { config: firstBindings.order }));
  await t.test("wrong Config owner", () => rejected("wrong Config owner", "AccountOwnedByWrongProgram", alice, next,
    { config: c.cashMint }));
  await t.test("wrong nonce PDA", () => rejected("wrong nonce PDA", "ConstraintSeeds", alice, next,
    { userNonce: bindings(bob, 0n).userNonce }));
  await t.test("wrong order PDA", () => rejected("wrong order PDA", "ConstraintSeeds", alice, next,
    { order: firstBindings.order }));
  await t.test("nonce uses big-endian seeds", () => {
    const [littleEndian] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), alice.key.publicKey.toBuffer(), u64le(next.nonce)], programId);
    return rejected("little-endian nonce PDA", "ConstraintSeeds", alice, next, { order: littleEndian });
  });
  await t.test("wrong escrow PDA", () => rejected("wrong escrow PDA", "ConstraintSeeds", alice, next,
    { escrow: firstBindings.escrow }));
  await t.test("wrong configured cash mint", async () => rejected("cash mint substitution", "InvalidBinding", alice, next,
    { cashMint: await foreignMint() }));
  await t.test("wrong configured YES mint", async () => rejected("YES mint substitution", "InvalidBinding", alice, next,
    { yesMint: await foreignMint() }));
  await t.test("wrong cash ATA original owner", () => rejected("other user's cash ATA", "InvalidUserToken", alice, next,
    { userCashAta: bob.cash }));
  await t.test("wrong YES ATA original owner", () => rejected("other user's YES ATA", "InvalidUserToken", alice, next,
    { userYesAta: bob.yes }));
  await t.test("cash token account with wrong mint", async () => rejected("wrong cash ATA mint", "InvalidUserToken", alice, next,
    { userCashAta: await rawToken(c.yesMint, alice.key.publicKey) }));
  await t.test("YES token account with wrong mint", async () => rejected("wrong YES ATA mint", "InvalidUserToken", alice, next,
    { userYesAta: await rawToken(c.cashMint, alice.key.publicKey) }));
  await t.test("correct cash owner/mint but noncanonical ATA address", async () => rejected("noncanonical cash ATA", "NoncanonicalAta", alice, next,
    { userCashAta: await rawToken(c.cashMint, alice.key.publicKey) }));
  await t.test("correct YES owner/mint but noncanonical ATA address", async () => rejected("noncanonical YES ATA", "NoncanonicalAta", alice, next,
    { userYesAta: await rawToken(c.yesMint, alice.key.publicKey) }));
  await t.test("canonical cash ATA reassigned to another owner", async () => {
    await setup([createSetAuthorityInstruction(alice.cash, alice.key.publicKey, AuthorityType.AccountOwner, bob.key.publicKey)], [alice.key]);
    await rejected("reassigned canonical ATA", "InvalidUserToken", alice, next);
    await setup([createSetAuthorityInstruction(alice.cash, bob.key.publicKey, AuthorityType.AccountOwner, alice.key.publicKey)], [bob.key]);
  });
  await t.test("alias user cash and YES accounts", () => rejected("aliased user accounts", "UnsafeAlias", alice, next,
    { userYesAta: alice.cash }));
  for (const field of ["tokenProgram", "associatedTokenProgram", "systemProgram"] as const) {
    await t.test(`wrong executable ${field}`, () => rejected(`wrong ${field}`, "InvalidProgramId", alice, next,
      { [field]: programId }));
  }
  await t.test("Token-2022 program substitution", () => rejected("Token-2022 program", "InvalidProgramId", alice, next,
    { tokenProgram: TOKEN_2022_PROGRAM_ID }));
  await t.test("actual Token-2022 mint substitution", async () => rejected("Token-2022 mint", "AccountOwnedByWrongProgram", alice, next,
    { cashMint: await foreignMint(true) }));
  await t.test("replay validates substituted accounts before accepting terms", () => rejected("replay ATA substitution", "InvalidUserToken", alice, first,
    { userCashAta: bob.cash }));
  await t.test("positive unattainable maximum minimum is accepted", async () => { await created("unattainable minimum", alice,
    { ...next, minimum: (1n << 64n) - 1n }, 3n); });
  await t.test("insufficient cash rolls back new Order, escrow, UserNonce, and rent", async () => {
    const a = bindings(poor, 0n);
    assert.equal(await info(a.userNonce), null);
    assert.equal(await info(a.order), null);
    assert.equal(await info(a.escrow), null);
    await rejected("new user insufficient cash", "insufficient funds", poor, first);
    assert.equal(await info(a.userNonce), null);
    assert.equal(await info(a.order), null);
    assert.equal(await info(a.escrow), null);
  });
  await t.test("replenishment permits the same nonce and identity to succeed once", async () => {
    await setup([createMintToInstruction(c.cashMint, poor.cash, faucet.publicKey, first.cash)]);
    await created("retry after failed transfer", poor, first, 1n);
    await replay("retry replay", poor, first);
  });
  await t.test("failed transfer preserves an existing nonce counter", async () => {
    const retry = { ...first, nonce: 1n };
    const a = bindings(poor, retry.nonce);
    const counterBefore = (await info(a.userNonce))!.data;
    await rejected("existing user insufficient cash", "insufficient funds", poor, retry);
    assert.deepEqual((await info(a.userNonce))!.data, counterBefore);
    assert.equal(await info(a.order), null); assert.equal(await info(a.escrow), null);
    await setup([createMintToInstruction(c.cashMint, poor.cash, faucet.publicKey, retry.cash)]);
    await created("existing counter retry", poor, retry, 2n);
    await replay("existing counter retry replay", poor, retry);
  });
  await t.test("largest valid cash bound reaches SPL transfer rather than amount rejection", () => rejected(
    "largest valid cash without funds", "insufficient funds", poor,
    { nonce: 2n, cash: ((1n << 64n) - 1n) / 2n, minimum: 1n }));
  await t.test("persist public finalized evidence and verify no YES issuance", async () => {
    assert.equal(unpackMint(c.yesMint, (await info(c.yesMint))!).supply, 0n);
    writeFileSync(join(runtime, "orders-evidence.json"), JSON.stringify({
      programId: programId.toBase58(), upgradeAuthority: null, orderSpace: 335, userNonceSpace: 81,
      finalizedRejectedTransactions: evidence.filter((entry) => entry.error !== null).length,
      successfulCreations: evidence.filter((entry) => entry.events === 1).length,
      successfulReplays: evidence.filter((entry) => entry.error === null && entry.events === 0).length,
      transactions: evidence,
    }, null, 2) + "\n");
  });
});
