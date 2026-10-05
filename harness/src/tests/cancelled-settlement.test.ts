import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import {
  ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createCloseAccountInstruction,
  createInitializeAccount3Instruction, createMintToInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";

const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
assert.ok(runtime && dirname(resolve(runtime)) === join(root, ".runtime"), "Use scripts/check-solana-cancelled.sh");
function credential(name: string) {
  const path = join(runtime!, name);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const faucet = credential("deployment-authority.json");
const operator = credential("operator-fixture.json");
const feePayer = Keypair.generate();
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const provider = new AnchorProvider(connection, new Wallet(feePayer), { commitment: "finalized" });
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, provider);
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
assert.ok(program.programId.equals(programId));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
const [yesAuthority] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
const eventParser = new EventParser(programId, program.coder);
const tracked = new Map<string, PublicKey>();
let latestSlot = 0;
let c: Awaited<ReturnType<typeof program.account.config.fetch>>;
const bn = (value: bigint) => new BN(value.toString());
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const u64be = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; };
const u64le = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const u128le = (value: bigint) => Buffer.concat([u64le(value & ((1n << 64n) - 1n)), u64le(value >> 64n)]);
const discriminator = (name: string) => sha(Buffer.from(`account:${name}`)).subarray(0, 8);
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item, 2);
const evidence: Record<string, unknown> = {
  programId: programId.toBase58(),
  artifactSha256: sha(readFileSync(join(root, "solana/target/deploy/settlement_lab.so"))).toString("hex"),
  boundary: "Actual local SBF instructions and legacy SPL operations; trusted operator attestation, no EVM verification",
  insufficientEscrowRefundCpiRollbackVerified: false, onChainU128OverflowVerified: false,
  transactions: [], checks: [],
};
function save() { writeFileSync(join(runtime!, "cancelled-evidence.json"), json(evidence) + "\n"); }
function track(...keys: PublicKey[]) {
  for (const key of keys) {
    assert.ok(!key.equals(feePayer.publicKey), "Fee payer is separate from protocol snapshots");
    tracked.set(key.toBase58(), key);
  }
}
async function info(key: PublicKey) {
  return connection.getAccountInfo(key, { commitment: "finalized", minContextSlot: latestSlot });
}
type Raw = { owner: string; data: string; lamports: string; executable: boolean; rentEpoch: string; space: number };
type Snapshot = { key: string; account: Raw | null }[];
// Preserve exact u64 RPC metadata before parsing, including the genesis wallet's
// lamports and u64::MAX rentEpoch. web3.js AccountInfo numbers cannot do this.
async function exactRpc(method: string, params: unknown[]) {
  const response = await fetch(connection.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok);
  const result = JSON.parse((await response.text()).replace(/("(?:lamports|rentEpoch)"\s*:\s*)(\d+)/g, '$1"$2"'));
  assert.equal(result.error, undefined); assert.ok(result.result);
  assert.ok(result.result.context.slot >= latestSlot);
  return result.result.value;
}
async function snapshot(keys = [...tracked.values()]): Promise<Snapshot> {
  const accounts = await exactRpc("getMultipleAccounts", [keys.map((key) => key.toBase58()),
    { commitment: "finalized", minContextSlot: latestSlot, encoding: "base64" }]);
  assert.equal(accounts.length, keys.length);
  return accounts.map((account: (Omit<Raw, "data"> & { data: [string, string] }) | null, i: number) => {
    if (account) {
      assert.equal(account.data[1], "base64"); assert.match(account.lamports, /^\d+$/); assert.match(account.rentEpoch, /^\d+$/);
    }
    return { key: keys[i].toBase58(), account: account && { ...account, data: Buffer.from(account.data[0], "base64").toString("hex") } };
  });
}
function edit(state: Snapshot, key: PublicKey, change: (data: Buffer) => void) {
  const entry = state.find((entry) => entry.key === key.toBase58()); assert.ok(entry?.account);
  const bytes = Buffer.from(entry.account.data, "hex"); change(bytes); entry.account.data = bytes.toString("hex");
}
async function lamports(key: PublicKey) { return BigInt((await snapshot([key]))[0].account?.lamports ?? "0"); }
async function amount(key: PublicKey) { const account = await info(key); assert.ok(account); return unpackAccount(key, account).amount; }
async function supply(key: PublicKey) { const account = await info(key); assert.ok(account); return unpackMint(key, account).supply; }
async function submit(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [], payer = feePayer) {
  const feeBefore = await lamports(payer.publicKey);
  const block = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({ ...block, feePayer: payer.publicKey }).add(...instructions);
  transaction.sign(...[...new Map([payer, ...signers].map((key) => [key.publicKey.toBase58(), key])).values()]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
  const deadline = Date.now() + 90_000;
  let status;
  while (Date.now() < deadline) {
    status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.confirmationStatus === "finalized") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.confirmationStatus, "finalized", `Finalization deadline: ${signature}`);
  const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  assert.ok(receipt?.meta); assert.deepEqual(receipt.meta.err, status.err);
  latestSlot = Math.max(latestSlot, receipt.slot);
  const events = [...eventParser.parseLogs(receipt.meta.logMessages ?? [])];
  const keys = receipt.transaction.message.staticAccountKeys;
  const entry = { name, signature, slot: receipt.slot, confirmationStatus: "finalized", error: receipt.meta.err,
    actualAnchorError: (receipt.meta.logMessages ?? []).map((line) => /Error Code: (\w+)\. Error Number: (\d+)/.exec(line))
      .filter((match) => match !== null).map((match) => ({ name: match[1], code: Number(match[2]) })),
    fee: receipt.meta.fee, events: events.map((event) => ({ name: event.name, data: Object.fromEntries(
      Object.entries(event.data).map(([key, value]) => [key, BN.isBN(value) ? value.toString()
        : value instanceof PublicKey ? value.toBase58() : value])) })), logs: receipt.meta.logMessages,
    cpis: receipt.meta.innerInstructions?.flatMap((group) => group.instructions.map((ix) => ({
      index: group.index, program: keys[ix.programIdIndex].toBase58(),
      accounts: ix.accounts.map((index) => keys[index].toBase58()),
      dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex"),
    }))) ?? [] };
  (evidence.transactions as unknown[]).push(entry); save();
  return { signature, receipt, events, entry, feeBefore, feeAfter: await lamports(payer.publicKey) };
}
type Result = Awaited<ReturnType<typeof submit>>;
function success(result: Result) { assert.equal(result.receipt.meta!.err, null, json(result.receipt.meta!.logMessages)); }
function feeOnly(result: Result, extra = 0n) { assert.equal(result.feeAfter, result.feeBefore - BigInt(result.receipt.meta!.fee) - extra); }
function noCpi(result: Result) {
  assert.equal(result.entry.cpis.length, 0);
  assert.ok(!(result.receipt.meta!.logMessages ?? []).some((line) => /invoke \[[2-9]/.test(line)));
}

type User = { key: Keypair; cash: PublicKey; yes: PublicKey };
type Terms = { nonce: bigint; cash: bigint; minimum: bigint };
type ModelOrder = { user: User; terms: Terms; state: 0 | 1 | 2 | 3; cancelled: boolean; donation: bigint };
const orders = new Map<string, ModelOrder>();
const nextNonces = new Map<string, bigint>();
const balances = new Map<string, bigint>();
let deposits = 0n; let refunds = 0n; let reimbursements = 0n; let issuance = 0n;
// Independently specified initialization fixture: one 10,000,000-unit executor
// cash mint, zero YES, zero orders/accounting. No prior suite evidence is read.
let cashSupply = 10_000_000n;
function delta(key: PublicKey, change: bigint) {
  const address = key.toBase58(); assert.ok(balances.has(address));
  const value = balances.get(address)! + change; assert.ok(value >= 0n); balances.set(address, value);
}
function bindings(user: User, terms: Terms) {
  const [userNonce, nonceBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.key.publicKey.toBuffer()], programId);
  const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.key.publicKey.toBuffer(), u64be(terms.nonce)], programId);
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  return { user: user.key.publicKey, config, accounting, userNonce, order, escrow, nonceBump, orderBump, escrowBump };
}
// Independent SPEC SHA-256 fixed-width encoding (not Borsh hash preimages).
function hashes(user: User, terms: Terms, terminal = 2) {
  const domain = Buffer.concat([Buffer.from(c.sourceDomain), Buffer.from(c.destinationDomain), programId.toBuffer(),
    Buffer.from(c.chainId), Buffer.from(c.settlement)]); assert.equal(domain.length, 148);
  const identity = Buffer.concat([Buffer.from("CCSLID01"), domain, user.key.publicKey.toBuffer(), u64be(terms.nonce)]);
  assert.equal(identity.length, 196); const orderId = sha(identity);
  const encoded = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.key.publicKey.toBuffer(), u64be(terms.nonce),
    Buffer.from(c.market), Buffer.from([c.outcome]), u64be(terms.cash), u64be(terms.minimum)]);
  assert.equal(encoded.length, 277); const termsHash = sha(encoded);
  const receiptBytes = Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([terminal]), u64be(terminal === 1 ? terms.cash * 2n : 0n)]);
  assert.equal(receiptBytes.length, 49); return { orderId, termsHash, receiptHash: sha(receiptBytes) };
}
function orderBytes(model: ModelOrder) {
  const { user, terms, state, cancelled } = model; const a = bindings(user, terms); const h = hashes(user, terms, state === 2 ? 1 : 2);
  const receipt = state < 2 ? Buffer.from([0, a.orderBump, a.escrowBump])
    : Buffer.concat([Buffer.from([1, state === 2 ? 1 : 2]), u64le(state === 2 ? terms.cash * 2n : 0n),
      h.receiptHash, Buffer.from([a.orderBump, a.escrowBump])]);
  const bytes = Buffer.concat([discriminator("Order"), config.toBuffer(), user.key.publicKey.toBuffer(), u64le(terms.nonce),
    Buffer.from(c.market), Buffer.from([c.outcome]), u64le(terms.cash), u64le(terms.minimum), h.orderId, h.termsHash,
    user.cash.toBuffer(), user.yes.toBuffer(), a.escrow.toBuffer(), Buffer.from([state, Number(cancelled)]), receipt]);
  const padded = Buffer.alloc(335); bytes.copy(padded); return padded;
}
function nonceBytes(user: User) {
  return Buffer.concat([discriminator("UserNonce"), config.toBuffer(), user.key.publicKey.toBuffer(),
    u64le(nextNonces.get(user.key.publicKey.toBase58())!), Buffer.from([bindings(user, { nonce: 0n, cash: 1n, minimum: 1n }).nonceBump])]);
}
function accountingBytes() { return Buffer.concat([discriminator("Accounting"), config.toBuffer(), u128le(deposits),
  u128le(refunds), u128le(reimbursements), u128le(issuance), Buffer.from([accountingBump])]); }
async function verifyModel() {
  assert.deepEqual((await info(accounting))!.data, accountingBytes());
  assert.equal(await supply(c.cashMint), cashSupply); assert.equal(await supply(c.yesMint), issuance);
  let escrowCash = 0n; let donated = 0n;
  for (const [address, model] of orders) {
    const a = bindings(model.user, model.terms);
    const raw = await info(a.order); assert.ok(raw); assert.ok(raw.owner.equals(programId)); assert.equal(raw.executable, false);
    assert.deepEqual(raw.data, orderBytes(model), `Independent complete Order serialization: ${address}`);
    assert.deepEqual((await info(a.userNonce))!.data, nonceBytes(model.user));
    const token = unpackAccount(a.escrow, (await info(a.escrow))!);
    assert.ok(token.owner.equals(a.order) && token.mint.equals(c.cashMint));
    assert.ok(token.isInitialized && !token.isFrozen); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
    const expected = (model.state < 2 ? model.terms.cash : 0n) + model.donation;
    assert.equal(token.amount, expected); escrowCash += expected; donated += model.donation;
  }
  for (const [key, expected] of balances) assert.equal(await amount(new PublicKey(key)), expected, `Independent balance: ${key}`);
  assert.equal(deposits, escrowCash - donated + refunds + reimbursements);
  // All initialized token accounts for each configured mint must be modeled;
  // this also checks the closed/recreated ATAs and conservation of supply.
  for (const [mint, expected] of [[c.cashMint, cashSupply], [c.yesMint, issuance]] as const) {
    const accounts = await exactRpc("getProgramAccounts", [TOKEN_PROGRAM_ID.toBase58(), {
      commitment: "finalized", minContextSlot: latestSlot, encoding: "base64", withContext: true,
      filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    }]);
    let total = 0n;
    for (const { pubkey, account } of accounts) {
      assert.ok(tracked.has(pubkey));
      const value = Buffer.from(account.data[0], "base64").readBigUInt64LE(64); total += value;
      const model = [...orders.values()].find((item) => bindings(item.user, item.terms).escrow.toBase58() === pubkey);
      const expectedBalance = model ? (model.state < 2 ? model.terms.cash : 0n) + model.donation : balances.get(pubkey);
      assert.equal(value, expectedBalance);
    }
    assert.equal(total, expected);
  }
}
async function createInstruction(user: User, terms: Terms) {
  const { nonceBump: _n, orderBump: _o, escrowBump: _e, ...a } = bindings(user, terms);
  return program.methods.createOrder({ nonce: bn(terms.nonce), cashAmount: bn(terms.cash), minimumShares: bn(terms.minimum) })
    .accountsStrict({ ...a, cashMint: c.cashMint, yesMint: c.yesMint, userCashAta: user.cash, userYesAta: user.yes,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
}
function deliveryArgs(user: User, terms: Terms, terminal = 2) {
  return { terms: { domain: { sourceDomain: [...c.sourceDomain], destinationDomain: [...c.destinationDomain], solanaProgram: programId,
    chainId: [...c.chainId], settlement: [...c.settlement] }, user: user.key.publicKey, nonce: bn(terms.nonce),
    market: [...c.market], outcome: c.outcome, cashAmount: bn(terms.cash), minimumShares: bn(terms.minimum) },
  receipt: { termsHash: [...hashes(user, terms).termsHash], terminal, filledQuantity: bn(terminal === 1 ? terms.cash * 2n : 0n) } };
}
function refundBindings(user: User, terms: Terms) {
  const a = bindings(user, terms);
  return { operator: operator.publicKey, user: a.user, config, accounting, userNonce: a.userNonce, order: a.order,
    cashMint: c.cashMint, userCashAta: user.cash, escrow: a.escrow, tokenProgram: TOKEN_PROGRAM_ID };
}
type RefundBindings = ReturnType<typeof refundBindings>;
type Args = ReturnType<typeof deliveryArgs>;
async function refundInstruction(user: User, terms: Terms, changes: Partial<RefundBindings> = {}, args = deliveryArgs(user, terms)) {
  const ix = await program.methods.acceptCancelled(args).accountsStrict({ ...refundBindings(user, terms), ...changes }).instruction();
  assert.equal(ix.keys.length, 10); assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isSigner, false); assert.equal(ix.keys[1].isWritable, false);
  if (!changes.cashMint) assert.ok(!ix.keys.some((meta) => meta.pubkey.equals(c.yesMint) || meta.pubkey.equals(user.yes)));
  return ix;
}
async function fillInstruction(user: User, terms: Terms) {
  const a = bindings(user, terms);
  return program.methods.acceptFilled(deliveryArgs(user, terms, 1)).accountsStrict({ operator: operator.publicKey,
    user: a.user, config, accounting, userNonce: a.userNonce, order: a.order, cashMint: c.cashMint, yesMint: c.yesMint,
    userYesAta: user.yes, escrow: a.escrow, executorCashAta: c.executorCashAta, yesAuthority, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
}
async function cancelInstruction(user: User, terms: Terms) {
  return program.methods.requestCancel(bn(terms.nonce), [...hashes(user, terms).termsHash]).accountsStrict({
    user: user.key.publicKey, config, order: bindings(user, terms).order }).instruction();
}
async function fixture(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [], extraFeeDebit = 0n) {
  const before = (await info(accounting))!.data;
  const result = await submit(name, instructions, signers); success(result); feeOnly(result, extraFeeDebit);
  assert.deepEqual((await info(accounting))!.data, before, "Fixture/user operations do not alter protocol counters");
  return result;
}
async function userFixture(name: string, cash: bigint): Promise<User> {
  const key = Keypair.generate(); const user = { key, cash: getAssociatedTokenAddressSync(c.cashMint, key.publicKey),
    yes: getAssociatedTokenAddressSync(c.yesMint, key.publicKey) };
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "finalized"));
  await fixture(`${name}: fund user and create genuine ATAs`, [
    SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: key.publicKey, lamports: 1_000_000_000 }),
    createAssociatedTokenAccountInstruction(feePayer.publicKey, user.cash, key.publicKey, c.cashMint),
    createAssociatedTokenAccountInstruction(feePayer.publicKey, user.yes, key.publicKey, c.yesMint),
    createMintToInstruction(c.cashMint, user.cash, faucet.publicKey, cash),
  ], [faucet], 1_000_000_000n + rent * 2n);
  track(key.publicKey, user.cash, user.yes);
  balances.set(user.cash.toBase58(), cash); balances.set(user.yes.toBase58(), 0n); cashSupply += cash;
  assert.equal(await lamports(user.cash), rent); assert.equal(await lamports(user.yes), rent);
  await verifyModel(); return user;
}
async function create(name: string, user: User, terms: Terms) {
  const a = bindings(user, terms); track(a.userNonce, a.order, a.escrow);
  assert.equal(await info(a.order), null); assert.equal(await info(a.escrow), null);
  const userBefore = await lamports(user.key.publicKey); const nonceMissing = await info(a.userNonce) === null;
  const result = await submit(name, [await createInstruction(user, terms)], [user.key]); success(result); feeOnly(result);
  deposits += terms.cash; delta(user.cash, -terms.cash);
  nextNonces.set(user.key.publicKey.toBase58(), terms.nonce + 1n);
  orders.set(a.order.toBase58(), { user, terms, state: 0, cancelled: false, donation: 0n });
  const rents = await Promise.all([335, ACCOUNT_SIZE, ...(nonceMissing ? [81] : [])].map((space) =>
    connection.getMinimumBalanceForRentExemption(space, "finalized")));
  assert.equal(await lamports(user.key.publicKey), userBefore - rents.reduce((sum, rent) => sum + BigInt(rent), 0n));
  for (const [key, space] of [[a.order, 335], [a.userNonce, 81], [a.escrow, ACCOUNT_SIZE]] as const)
    assert.equal(await lamports(key), BigInt(await connection.getMinimumBalanceForRentExemption(space, "finalized")));
  assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "orderCreated");
  await verifyModel();
}
async function cancel(name: string, user: User, terms: Terms) {
  const a = bindings(user, terms); const before = await snapshot();
  const result = await submit(name, [await cancelInstruction(user, terms)], [user.key]); success(result); feeOnly(result); noCpi(result);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "cancellationRequested");
  const model = orders.get(a.order.toBase58())!; model.state = 1; model.cancelled = true;
  edit(before, a.order, (bytes) => { bytes[289] = 1; bytes[290] = 1; });
  assert.deepEqual(await snapshot(), before); await verifyModel();
}
function tokenCpi(result: Result, index: number, tag: number, value: bigint, accounts: PublicKey[]) {
  const cpi = result.entry.cpis[index]; assert.ok(cpi);
  const data = Buffer.concat([Buffer.from([tag]), u64le(value), Buffer.from([6])]);
  assert.equal(cpi.index, 0); assert.equal(cpi.program, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(cpi.dataHex, data.toString("hex")); assert.deepEqual(cpi.accounts, accounts.map((key) => key.toBase58()));
}
function deliveryEvent(result: Result, user: User, terms: Terms, filled: boolean) {
  assert.equal(result.events.length, 1); const event = result.events[0];
  assert.equal(event.name, filled ? "filledAccepted" : "cancelledAccepted");
  const h = hashes(user, terms, filled ? 1 : 2);
  const expected: Record<string, unknown> = { order: bindings(user, terms).order.toBase58(), termsHash: [...h.termsHash],
    receiptHash: [...h.receiptHash], cashAmount: String(terms.cash) };
  if (filled) expected.filledQuantity = String(terms.cash * 2n);
  // Compare exact integer values, not BN's spare internal word-array capacity.
  assert.deepEqual(result.entry.events[0].data, expected);
  const message = result.receipt.transaction.message;
  assert.ok(!message.staticAccountKeys.some((key, index) => key.equals(user.key.publicKey) && message.isAccountSigner(index)),
    "Original user does not sign operator delivery");
}
async function accept(name: string, user: User, terms: Terms, filled = false) {
  const a = bindings(user, terms); const before = await snapshot();
  const result = await submit(name, [filled ? await fillInstruction(user, terms) : await refundInstruction(user, terms)], [operator]);
  success(result); feeOnly(result); deliveryEvent(result, user, terms, filled);
  const model = orders.get(a.order.toBase58())!;
  if (filled) {
    reimbursements += terms.cash; issuance += terms.cash * 2n; model.state = 2;
    delta(c.executorCashAta, terms.cash); delta(user.yes, terms.cash * 2n);
    assert.equal(result.entry.cpis.length, 2);
    tokenCpi(result, 0, 14, terms.cash * 2n, [c.yesMint, user.yes, yesAuthority]);
    tokenCpi(result, 1, 12, terms.cash, [a.escrow, c.cashMint, c.executorCashAta, a.order]);
    edit(before, c.yesMint, (bytes) => bytes.writeBigUInt64LE(issuance, 36));
    edit(before, user.yes, (bytes) => bytes.writeBigUInt64LE(balances.get(user.yes.toBase58())!, 64));
    edit(before, c.executorCashAta, (bytes) => bytes.writeBigUInt64LE(balances.get(c.executorCashAta.toBase58())!, 64));
  } else {
    refunds += terms.cash; model.state = 3; delta(user.cash, terms.cash);
    assert.equal(result.entry.cpis.length, 1);
    tokenCpi(result, 0, 12, terms.cash, [a.escrow, c.cashMint, user.cash, a.order]);
    edit(before, user.cash, (bytes) => bytes.writeBigUInt64LE(balances.get(user.cash.toBase58())!, 64));
  }
  edit(before, a.escrow, (bytes) => bytes.writeBigUInt64LE(model.donation, 64));
  edit(before, accounting, (bytes) => accountingBytes().copy(bytes));
  edit(before, a.order, (bytes) => orderBytes(model).copy(bytes));
  assert.deepEqual(await snapshot(), before, "Only independently intended token, counter and terminal bytes change; nonce, rent and bumps persist");
  await verifyModel();
  (evidence.checks as unknown[]).push({ name, outcome: filled ? "Settled" : "Refunded",
    termsHash: hashes(user, terms).termsHash.toString("hex"), receiptHash: hashes(user, terms, filled ? 1 : 2).receiptHash.toString("hex"),
    expectedSnapshot: before }); save();
}
const constraintErrors: Record<string, number> = {
  AccountNotSigner: 3010, AccountNotInitialized: 3012, AccountDiscriminatorMismatch: 3002,
  ConstraintSeeds: 2006, ConstraintDuplicateMutableAccount: 2040, InvalidProgramId: 3008,
};
async function unchanged(name: string, ix: TransactionInstruction, signers: Keypair[], expectedError?: string) {
  const before = await snapshot(); const result = await submit(name, [ix], signers); feeOnly(result); noCpi(result);
  assert.equal(result.events.length, 0);
  if (expectedError) {
    const code = idl.errors.find((error) => error.name === expectedError)?.code ?? constraintErrors[expectedError];
    assert.ok(code !== undefined, `Known expected error: ${expectedError}`);
    assert.deepEqual(result.receipt.meta!.err, { InstructionError: [0, { Custom: code }] });
    assert.deepEqual(result.entry.actualAnchorError, [{ name: expectedError, code }]);
    assert.ok(result.receipt.meta!.logMessages?.includes(`Program ${programId} invoke [1]`), "SBF rejection actually executed");
  } else success(result);
  const after = await snapshot(); assert.deepEqual(after, before, `${name}: complete tracked protocol/token metadata and bytes preserved`);
  await verifyModel();
  (evidence.checks as unknown[]).push({ name, outcome: expectedError ?? "Replay", snapshotsUnchanged: true,
    snapshotSha256: sha(Buffer.from(json(before))).toString("hex") }); save();
}
async function reject(name: string, user: User, terms: Terms, expected: string, changes: Partial<RefundBindings> = {},
  alter?: (args: Args) => void, signer = operator) {
  const args = deliveryArgs(user, terms); alter?.(args);
  await unchanged(name, await refundInstruction(user, terms, changes, args), [signer], expected);
}

const standard: Terms = { nonce: 0n, cash: 10_000_000n, minimum: 20_000_000n };
const adversarial: Terms = { nonce: 0n, cash: 5_000_000n, minimum: 10_000_000n };
const unattainable: Terms = { nonce: 0n, cash: 1n, minimum: (1n << 64n) - 1n };
const purchase: Terms = { nonce: 0n, cash: 3_000_000n, minimum: 6_000_000n };
let alice: User; let bob: User; let recovery: User; let buyer: User; let noncanonical: PublicKey;

test("actual SBF operator-attested Cancelled settlement", { timeout: 850_000 }, async (t) => {
  await t.test("independent zero-order baseline, immutable SBF and separately funded fee payer", async () => {
    const raw = await info(config); assert.ok(raw); c = program.coder.accounts.decode("config", raw.data);
    assert.ok(operator.publicKey.equals(c.solanaOperator));
    assert.equal((await info(programData))!.data[12], 0);
    assert.deepEqual((await info(programData))!.data.subarray(45, 45 + readFileSync(join(root, "solana/target/deploy/settlement_lab.so")).length),
      readFileSync(join(root, "solana/target/deploy/settlement_lab.so")));
    const bootstrap = await submit("fixture: fund separate fee payer and configured operator", [
      SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: feePayer.publicKey, lamports: 10_000_000_000 }),
      SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: operator.publicKey, lamports: 1_000_000 }),
    ], [], faucet); success(bootstrap); feeOnly(bootstrap, 10_001_000_000n);
    track(config, accounting, c.cashMint, c.yesMint, c.executorCashAta, programId, programData,
      faucet.publicKey, operator.publicKey, c.solanaExecutor);
    const records = await exactRpc("getProgramAccounts", [programId.toBase58(), { commitment: "finalized", minContextSlot: latestSlot,
      encoding: "base64", withContext: true, filters: [{ dataSize: 335 }, { memcmp: { offset: 0,
        bytes: anchor.utils.bytes.bs58.encode(discriminator("Order")) } }] }]);
    assert.equal(records.length, 0);
    for (const mint of [c.cashMint, c.yesMint]) {
      const accounts = await exactRpc("getProgramAccounts", [TOKEN_PROGRAM_ID.toBase58(), { commitment: "finalized", minContextSlot: latestSlot,
        encoding: "base64", withContext: true, filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] }]);
      for (const { pubkey, account } of accounts) {
        const key = new PublicKey(pubkey); track(key);
        const expected = key.equals(c.executorCashAta) ? 10_000_000n : 0n;
        assert.equal(Buffer.from(account.data[0], "base64").readBigUInt64LE(64), expected); balances.set(pubkey, expected);
      }
    }
    await verifyModel();
    alice = await userFixture("alice", standard.cash + 17n);
    bob = await userFixture("bob", adversarial.cash);
    recovery = await userFixture("recovery", unattainable.cash);
    buyer = await userFixture("buyer", purchase.cash);
    await create("create real Pending order", alice, standard);
  });
  await t.test("valid Cancelled receipt before user cancellation executes and rejects without payout", async () => {
    await reject("Pending cancellation receipt", alice, standard, "RefundCancellationNotRequested");
  });
  await t.test("original user's signed cancellation retains deposit and advances only request state", async () => {
    await cancel("original user cancellation", alice, standard);
  });
  await t.test("genuine SPL donation is tracked separately from deposit and counters", async () => {
    const a = bindings(alice, standard); const before = await snapshot();
    await fixture("user SPL donation", [createTransferCheckedInstruction(alice.cash, c.cashMint, a.escrow, alice.key.publicKey, 17n, 6)], [alice.key]);
    orders.get(a.order.toBase58())!.donation += 17n; delta(alice.cash, -17n);
    edit(before, alice.cash, (bytes) => bytes.writeBigUInt64LE(0n, 64));
    edit(before, a.escrow, (bytes) => bytes.writeBigUInt64LE(standard.cash + 17n, 64));
    assert.deepEqual(await snapshot(), before); await verifyModel();
  });
  await t.test("configured operator refunds deposit once with one checked CPI/event and retained donation", async () => {
    await accept("donated escrow refund", alice, standard);
    assert.equal(await amount(alice.cash), standard.cash); assert.equal(await amount(bindings(alice, standard).escrow), 17n);
  });
  await t.test("exact Cancelled receipt replay preserves complete snapshots without a second refund", async () => {
    await unchanged("donated refund exact replay", await refundInstruction(alice, standard), [operator]);
  });
  await t.test("exact creation and cancellation replays after refund preserve deposit, nonce and counters", async () => {
    await unchanged("create_order replay after refund", await createInstruction(alice, standard), [alice.key]);
    await unchanged("request_cancel replay after refund", await cancelInstruction(alice, standard), [alice.key]);
  });
  await t.test("valid Filled after Refunded is rejected without issuing YES or reimbursing executor", async () => {
    await unchanged("Filled conflicts with Refunded", await fillInstruction(alice, standard), [operator], "FilledInconsistentRecord");
  });
  await t.test("conflicting terms and receipt cannot overwrite an accepted refund", async () => {
    await reject("changed terms after refund", alice, standard, "RefundTermsConflict", {}, (args) => { args.terms.cashAmount = bn(standard.cash + 1n); });
    await reject("changed receipt after refund", alice, standard, "RefundInvalidReceipt", {}, (args) => { args.receipt.filledQuantity = bn(1n); });
  });
  await t.test("legal unattainable minimum can create and request cancellation", async () => {
    await create("create unattainable minimum", recovery, unattainable);
    await cancel("cancel unattainable minimum", recovery, unattainable);
  });
  await t.test("owner genuinely closes empty YES and cash ATAs; rent effects are separate", async () => {
    for (const key of [recovery.yes, recovery.cash]) {
      assert.equal(await amount(key), 0n); const before = await snapshot(); const rent = await lamports(key);
      await fixture(`owner closes ${key.equals(recovery.yes) ? "YES" : "cash"} ATA`, [
        createCloseAccountInstruction(key, recovery.key.publicKey, recovery.key.publicKey),
      ], [recovery.key]);
      balances.delete(key.toBase58()); before.find((entry) => entry.key === key.toBase58())!.account = null;
      const user = before.find((entry) => entry.key === recovery.key.publicKey.toBase58())!;
      assert.ok(user.account); user.account.lamports = String(BigInt(user.account.lamports) + rent);
      assert.deepEqual(await snapshot(), before); assert.equal(await info(key), null); await verifyModel();
    }
  });
  await t.test("missing cash ATA executes AccountNotInitialized before any SPL refund CPI", async () => {
    // Anchor TokenAccount validation precedes the handler; this is not a failed
    // SPL TransferChecked or proof of insufficient-escrow rollback.
    await reject("missing cash ATA account-validation failure", recovery, unattainable, "AccountNotInitialized");
  });
  await t.test("genuine canonical cash ATA recreation enables the identical receipt without live YES ATA", async () => {
    const before = await snapshot(); const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "finalized"));
    await fixture("recreate canonical cash ATA", [createAssociatedTokenAccountInstruction(feePayer.publicKey, recovery.cash,
      recovery.key.publicKey, c.cashMint)], [], rent);
    balances.set(recovery.cash.toBase58(), 0n);
    const after = await snapshot();
    assert.deepEqual(after.filter((entry) => entry.key !== recovery.cash.toBase58()), before.filter((entry) => entry.key !== recovery.cash.toBase58()));
    assert.equal(await lamports(recovery.cash), rent); assert.equal(await info(recovery.yes), null); await verifyModel();
    await accept("unattainable minimum refund after ATA recreation", recovery, unattainable);
    assert.equal(await info(recovery.yes), null); assert.equal(await amount(recovery.cash), 1n);
  });
  await t.test("exact refund replay accepts initialized zero escrow and absent YES ATA without paying twice", async () => {
    assert.equal(await amount(bindings(recovery, unattainable).escrow), 0n);
    await unchanged("zero escrow refund replay", await refundInstruction(recovery, unattainable), [operator]);
  });
  await t.test("Filled after real cancellation issues exact YES and reimburses while retaining request history", async () => {
    await create("create purchase", buyer, purchase); await cancel("purchase cancellation request", buyer, purchase);
    await accept("Filled wins after cancellation", buyer, purchase, true);
  });
  await t.test("valid Cancelled after Settled rejects terminal conflict with no refund or issuance change", async () => {
    await reject("Cancelled conflicts with Settled", buyer, purchase, "RefundTerminalConflict");
    assert.equal(await amount(buyer.yes), purchase.cash * 2n);
    assert.equal(await amount(c.executorCashAta), 10_000_000n + purchase.cash);
    assert.ok(orders.get(bindings(buyer, purchase).order.toBase58())!.cancelled);
  });
  await t.test("otherwise valid CancelRequested adversarial order and noncanonical user cash fixture", async () => {
    await create("create adversarial order", bob, adversarial); await cancel("adversarial user cancellation", bob, adversarial);
    const key = Keypair.generate(); noncanonical = key.publicKey;
    const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "finalized");
    await fixture("create noncanonical owner-matching cash account", [SystemProgram.createAccount({ fromPubkey: feePayer.publicKey,
      newAccountPubkey: key.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(key.publicKey, c.cashMint, bob.key.publicKey)], [key], BigInt(rent));
    track(key.publicKey); balances.set(key.publicKey.toBase58(), 0n); await verifyModel();
  });
  await t.test("wrong operator's actual signature rejects the configured operator address constraint", async () => {
    await reject("signed wrong operator", bob, adversarial, "RefundUnauthorizedOperator", { operator: alice.key.publicKey }, undefined, alice.key);
  });
  await t.test("configured operator without signer privilege executes AccountNotSigner", async () => {
    const ix = await refundInstruction(bob, adversarial); ix.keys[0].isSigner = false;
    await unchanged("configured operator without signer privilege", ix, [], "AccountNotSigner");
  });
  // Existing records have the correct discriminator; PDA substitution therefore
  // reaches ConstraintSeeds. Cross-type Accounting substitution is rejected by
  // Anchor deserialization first, before its seed or handler binding checks.
  // A recipient/escrow alias reaches Anchor duplicate-mutable-account validation
  // before the handler can report RefundUnsafeAlias.
  const accounts: [string, string, () => Partial<RefundBindings>][] = [
    ["wrong original user", "ConstraintSeeds", () => ({ user: alice.key.publicKey })],
    ["wrong Order", "ConstraintSeeds", () => ({ order: bindings(alice, standard).order })],
    ["wrong Accounting type", "AccountDiscriminatorMismatch", () => ({ accounting: bindings(alice, standard).userNonce })],
    ["wrong UserNonce", "ConstraintSeeds", () => ({ userNonce: bindings(alice, standard).userNonce })],
    ["noncanonical owner-matching cash account", "RefundInvalidBinding", () => ({ userCashAta: noncanonical })],
    ["another user's cash ATA", "RefundInvalidBinding", () => ({ userCashAta: alice.cash })],
    ["wrong cash mint", "RefundInvalidBinding", () => ({ cashMint: c.yesMint })],
    ["wrong token program", "InvalidProgramId", () => ({ tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })],
    ["unsafe recipient/escrow alias", "ConstraintDuplicateMutableAccount", () => ({ userCashAta: bindings(bob, adversarial).escrow })],
  ];
  for (const [name, error, changes] of accounts) await t.test(`${name}: finalized rejection preserves full snapshots`, async () => {
    await reject(name, bob, adversarial, error, changes());
  });
  const inputs: [string, string, (args: Args) => void][] = [
    ["wrong nonce binding", "ConstraintSeeds", (args) => { args.terms.nonce = bn(1n); }],
    ["wrong supplied original user", "RefundTermsConflict", (args) => { args.terms.user = alice.key.publicKey; }],
    ["changed cash", "RefundTermsConflict", (args) => { args.terms.cashAmount = bn(adversarial.cash + 1n); }],
    ["changed minimum", "RefundTermsConflict", (args) => { args.terms.minimumShares = bn(1n); }],
    ["changed market", "RefundTermsConflict", (args) => { args.terms.market[0] ^= 0x80; }],
    ["changed outcome", "RefundTermsConflict", (args) => { args.terms.outcome = 1; }],
    ["changed source domain", "RefundTermsConflict", (args) => { args.terms.domain.sourceDomain[0] ^= 0x80; }],
    ["changed destination domain", "RefundTermsConflict", (args) => { args.terms.domain.destinationDomain[0] ^= 0x80; }],
    ["changed deployment program", "RefundTermsConflict", (args) => { args.terms.domain.solanaProgram = SystemProgram.programId; }],
    ["changed high-order EVM chain-ID byte", "RefundTermsConflict", (args) => { args.terms.domain.chainId[0] ^= 0x80; }],
    ["changed EVM settlement deployment", "RefundTermsConflict", (args) => { args.terms.domain.settlement[0] ^= 0x80; }],
    ["wrong receipt terms_hash", "RefundInvalidReceipt", (args) => { args.receipt.termsHash[0] ^= 0x80; }],
    ...[0, 1, 255].map((tag): [string, string, (args: Args) => void] =>
      [`receipt terminal ${tag}`, "RefundInvalidReceipt", (args) => { args.receipt.terminal = tag; }]),
    ["nonzero Cancelled quantity", "RefundInvalidReceipt", (args) => { args.receipt.filledQuantity = bn(1n); }],
  ];
  for (const [name, error, alter] of inputs) await t.test(`${name}: finalized rejection preserves full snapshots`, async () => {
    await reject(name, bob, adversarial, error, {}, alter);
  });
  await t.test("final independent accounting, balances, custody and permanent receipt reconciliation", async () => {
    await verifyModel();
    assert.equal(deposits, 18_000_001n); assert.equal(refunds, 10_000_001n);
    assert.equal(reimbursements, 3_000_000n); assert.equal(issuance, 6_000_000n); assert.equal(cashSupply, 28_000_018n);
    evidence.model = { deposits, refunds, reimbursements, cumulativeIssuance: issuance, currentYesSupply: issuance,
      cashSupply, outstandingCash: deposits - refunds - reimbursements, donations: 17n, balances: [...balances],
      orders: [...orders.values()].map((model) => ({ order: bindings(model.user, model.terms).order.toBase58(),
        user: model.user.key.publicKey.toBase58(), terms: model.terms, state: model.state, cancellationRequested: model.cancelled,
        donation: model.donation, ...Object.fromEntries(Object.entries(hashes(model.user, model.terms, model.state === 2 ? 1 : 2))
          .map(([key, value]) => [key, value.toString("hex")])) })) };
    const transactions = evidence.transactions as Result["entry"][];
    evidence.summary = { finalizedTransactions: transactions.length, finalizedRejections: transactions.filter((item) => item.error !== null).length,
      successfulRefunds: transactions.filter((item) => item.events.some((event) => event.name === "cancelledAccepted")).length,
      successfulFills: transactions.filter((item) => item.events.some((event) => event.name === "filledAccepted")).length,
      exactProtocolReplays: 4, originalUserSignedCancellations: 4, realCreations: 4 };
    evidence.finalSnapshot = await snapshot(); save();
  });
});
