import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";

const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
const phase = process.env.CANCELLED_ROLLBACK_PHASE;
assert.ok(runtime && dirname(resolve(runtime)) === join(root, ".runtime"));
assert.ok(phase === "prepare" || phase === "verify", "Use the isolated cancelled-rollback runner");
function credential(name: string, create = false) {
  const path = join(runtime!, name);
  if (create) {
    const key = Keypair.generate();
    writeFileSync(path, JSON.stringify([...key.secretKey]) + "\n", { mode: 0o600, flag: "wx" });
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const cashAuthority = credential("deployment-authority.json");
const operator = credential("operator-fixture.json");
const user = credential("cancelled-rollback-user.json", phase === "prepare");
const feePayer = credential("cancelled-rollback-fee-payer.json", phase === "prepare");
// Each phase runs in a new Node process: no slot or blockhash crosses ledgers.
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const provider = new AnchorProvider(connection, new Wallet(feePayer), { commitment: "finalized" });
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, provider);
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
assert.ok(program.programId.equals(programId));
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
const cash = 10_000_000n;
const quantity = 20_000_000n;
const nonce = 0n;
const bn = (value: bigint) => new BN(value.toString());
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const u64be = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; };
const u128le = (value: bigint) => {
  const bytes = Buffer.alloc(16); bytes.writeBigUInt64LE(value & ((1n << 64n) - 1n));
  bytes.writeBigUInt64LE(value >> 64n, 8); return bytes;
};
const [userNonce, nonceBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.publicKey.toBuffer()], programId);
const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.publicKey.toBuffer(), u64be(nonce)], programId);
const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
const eventParser = new EventParser(programId, program.coder);
let c: Awaited<ReturnType<typeof program.account.config.fetch>>;
let userCash: PublicKey;
let userYes: PublicKey;
let latestSlot = 0;
const tracked = new Map<string, PublicKey>();
type Raw = { owner: string; data: string; lamports: string; executable: boolean; rentEpoch: string; space: number };
type Snapshot = { key: string; account: Raw }[];
type Dump = { pubkey: string; account: { owner: string; data: [string, string]; lamports: string; executable: boolean; rentEpoch: string; space: number } };
type Manifest = { keys: string[]; cashMint: string; yesMint: string; escrow: string; feePayer: string; preparationSlot: number };
const evidence: Record<string, unknown> = phase === "verify"
  ? JSON.parse(readFileSync(join(runtime, "cancelled-rollback-evidence.json"), "utf8"))
  : { programId: programId.toBase58(), artifactSha256: sha(readFileSync(join(root, "solana/target/deploy/settlement_lab.so"))).toString("hex"),
    boundary: "Controlled genesis fault injection; fixture restoration is not a production recovery mechanism; no EVM or bridge verification",
    runIdentity: runtime, transactions: [], conservation: [] };
function saveEvidence() {
  writeFileSync(join(runtime!, "cancelled-rollback-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
}
function track(...keys: PublicKey[]) {
  for (const key of keys) {
    assert.ok(!key.equals(feePayer.publicKey), "Separate fee payer is excluded from protocol snapshots");
    tracked.set(key.toBase58(), key);
  }
}
async function info(key: PublicKey) {
  const account = await connection.getAccountInfo(key, { commitment: "finalized", minContextSlot: latestSlot });
  assert.ok(account, `Missing ${key.toBase58()}`); return account;
}
// Preserve u64 lamports and rentEpoch before JSON.parse; web3 numbers can round.
// The CLI dump and RPC snapshot use the same exact metadata representation.
function exactMetadataJson(text: string) {
  return JSON.parse(text.replace(/("(?:lamports|rentEpoch)"\s*:\s*)(\d+)/g, '$1"$2"'));
}
async function snapshot(publicKeys = [...tracked.values()]): Promise<Snapshot> {
  const keys = publicKeys.map((key) => key.toBase58());
  const response = await fetch(connection.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys,
      { commitment: "finalized", minContextSlot: latestSlot, encoding: "base64" }] }), signal: AbortSignal.timeout(10_000) });
  assert.equal(response.ok, true);
  const result = exactMetadataJson(await response.text()) as {
    error?: unknown; result?: { context: { slot: number }; value: (Dump["account"] | null)[] };
  };
  assert.equal(result.error, undefined); assert.ok(result.result); assert.ok(result.result.context.slot >= latestSlot);
  const accounts = result.result.value; assert.equal(accounts.length, keys.length);
  return accounts.map((account, i) => {
    assert.ok(account); assert.equal(account.data[1], "base64"); assert.match(account.lamports, /^\d+$/); assert.match(account.rentEpoch, /^\d+$/);
    return { key: keys[i], account: { owner: account.owner, data: Buffer.from(account.data[0], "base64").toString("hex"),
      lamports: account.lamports, executable: account.executable, rentEpoch: account.rentEpoch, space: account.space } };
  });
}
function edit(state: Snapshot, key: PublicKey, change: (bytes: Buffer) => void) {
  const entry = state.find((entry) => entry.key === key.toBase58()); assert.ok(entry);
  const bytes = Buffer.from(entry.account.data, "hex"); change(bytes); entry.account.data = bytes.toString("hex");
}
async function amount(key: PublicKey) { return unpackAccount(key, await info(key)).amount; }
async function supply(key: PublicKey) { return unpackMint(key, await info(key)).supply; }
async function submit(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [], payer = feePayer) {
  const beforePayer = (await snapshot([payer.publicKey]))[0];
  const beforeFee = BigInt(beforePayer.account.lamports);
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
  (evidence.transactions as unknown[]).push({ name, phase, ledger: phase === "prepare" ? "ledger" : "cancelled-rollback-ledger",
    signature, slot: receipt.slot, confirmationStatus: "finalized", error: receipt.meta.err, fee: receipt.meta.fee,
    blockhash: block.blockhash, feePayer: payer.publicKey.toBase58(),
    outer: receipt.transaction.message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex].toBase58(), accounts: ix.accountKeyIndexes.map((i) => ({
        key: keys[i].toBase58(), signer: receipt.transaction.message.isAccountSigner(i), writable: receipt.transaction.message.isAccountWritable(i),
      })), dataHex: Buffer.from(ix.data).toString("hex"),
    })),
    events: events.map((event) => ({ name: event.name, data: Object.fromEntries(Object.entries(event.data).map(([key, value]) =>
      [key, BN.isBN(value) ? value.toString() : value instanceof PublicKey ? value.toBase58() : value])) })), logs: receipt.meta.logMessages, inner: receipt.meta.innerInstructions?.map((group) => ({
      index: group.index, instructions: group.instructions.map((ix) => ({
        program: keys[ix.programIdIndex].toBase58(), accounts: ix.accounts.map((index) => keys[index].toBase58()),
        dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex"),
      })),
    })) });
  if (payer === feePayer) {
    const expectedPayer = structuredClone(beforePayer);
    expectedPayer.account.lamports = (beforeFee - BigInt(receipt.meta.fee)).toString();
    const afterPayer = (await snapshot([payer.publicKey]))[0];
    assert.deepEqual(afterPayer, expectedPayer, "Only the separate fee payer's exact fee debit changes");
    Object.assign((evidence.transactions as object[]).at(-1)!, { feePayerBefore: beforePayer, feePayerAfter: afterPayer });
  }
  saveEvidence();
  return { signature, receipt, events, blockhash: block.blockhash };
}
type Result = Awaited<ReturnType<typeof submit>>;
function success(result: Result) { assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages)); }
// Independent SPEC fixed-width Node crypto encoding, not a Rust encoding helper.
function hashes() {
  const domain = Buffer.concat([Buffer.from(c.sourceDomain), Buffer.from(c.destinationDomain), programId.toBuffer(),
    Buffer.from(c.chainId), Buffer.from(c.settlement)]); assert.equal(domain.length, 148);
  const identity = Buffer.concat([Buffer.from("CCSLID01"), domain, user.publicKey.toBuffer(), u64be(nonce)]);
  assert.equal(identity.length, 196); const orderId = sha(identity);
  const terms = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.publicKey.toBuffer(), u64be(nonce),
    Buffer.from(c.market), Buffer.from([c.outcome]), u64be(cash), u64be(quantity)]);
  assert.equal(terms.length, 277); const termsHash = sha(terms);
  const receipt = Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([2]), u64be(0n)]);
  assert.equal(receipt.length, 49); return { orderId, termsHash, receiptHash: sha(receipt) };
}
async function refundInstruction() {
  const ix = await program.methods.acceptCancelled({ terms: {
    domain: { sourceDomain: c.sourceDomain, destinationDomain: c.destinationDomain, solanaProgram: programId,
      chainId: c.chainId, settlement: c.settlement }, user: user.publicKey, nonce: bn(nonce), market: c.market,
    outcome: c.outcome, cashAmount: bn(cash), minimumShares: bn(quantity),
  }, receipt: { termsHash: [...hashes().termsHash], terminal: 2, filledQuantity: bn(0n) } }).accountsStrict({
    operator: operator.publicKey, user: user.publicKey, config, accounting, userNonce, order,
    cashMint: c.cashMint, userCashAta: userCash, escrow, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
  assert.equal(ix.keys.length, 10); assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].isSigner, false); assert.equal(ix.keys[1].isWritable, false); return ix;
}
function verifyCpis(result: Result, failure: boolean) {
  const inner = result.receipt.meta!.innerInstructions; assert.equal(inner?.length, 1);
  assert.equal(inner![0].index, 0); assert.equal(inner![0].instructions.length, 1, "Exactly one attempted refund CPI");
  const message = result.receipt.transaction.message;
  const keys = message.staticAccountKeys;
  assert.equal(message.compiledInstructions.length, 1);
  assert.ok(keys[message.compiledInstructions[0].programIdIndex].equals(programId));
  assert.ok(!keys.some((key, index) => key.equals(user.publicKey) && message.isAccountSigner(index)));
  assert.ok(keys.some((key, index) => key.equals(operator.publicKey) && message.isAccountSigner(index)));
  const ix = inner![0].instructions[0];
  const expected = Buffer.alloc(10); expected[0] = 12; expected.writeBigUInt64LE(cash, 1); expected[9] = 6;
  assert.deepEqual(Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)), expected);
  assert.ok(keys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID));
  assert.deepEqual(ix.accounts.map((i) => keys[i].toBase58()), [escrow, c.cashMint, userCash, order].map((key) => key.toBase58()));
  const logs = result.receipt.meta!.logMessages ?? [];
  const programInvoke = logs.indexOf(`Program ${programId} invoke [1]`);
  const invokes = logs.flatMap((line, i) => /invoke \[\d+\]/.test(line) ? [i] : []);
  assert.equal(invokes.length, 2, "Only the outer SBF invocation and legacy SPL refund invocation");
  assert.equal(invokes[0], programInvoke); assert.ok(programInvoke >= 0);
  assert.equal(logs[invokes[1]], `Program ${TOKEN_PROGRAM_ID} invoke [2]`);
  assert.equal(logs.filter((line) => line === "Program log: Instruction: AcceptCancelled").length, 1);
  if (failure) {
    assert.deepEqual(result.receipt.meta!.err, { InstructionError: [0, { Custom: 1 }] });
    const insufficient = logs.findIndex((line) => /insufficient funds/i.test(line));
    const tokenFailure = logs.indexOf(`Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x1`);
    const outerFailure = logs.indexOf(`Program ${programId} failed: custom program error: 0x1`);
    assert.ok(invokes[1] < insufficient && insufficient < tokenFailure && tokenFailure < outerFailure);
    assert.equal(logs.filter((line) => line === `Program ${TOKEN_PROGRAM_ID} success`).length, 0);
    assert.equal(result.events.length, 0); assert.ok(!logs.some((line) => line.startsWith("Program data:")));
  } else {
    assert.equal(logs.filter((line) => line === `Program ${TOKEN_PROGRAM_ID} success`).length, 1);
    assert.ok(logs.indexOf(`Program ${programId} success`) > invokes[1]);
    assert.equal(logs.filter((line) => line.startsWith("Program data:")).length, 1);
  }
}
async function verifyAccounting(refunded = 0n) {
  const raw = await info(accounting);
  assert.deepEqual(raw.data, Buffer.concat([sha(Buffer.from("account:Accounting")).subarray(0, 8), config.toBuffer(),
    u128le(cash), u128le(refunded), u128le(0n), u128le(0n), Buffer.from([accountingBump])]));
}
async function verifyOrder(refunded = false) {
  const o = await program.account.order.fetch(order, "finalized");
  assert.deepEqual(o.state, refunded ? { refunded: {} } : { cancelRequested: {} });
  assert.equal(o.cancellationRequested, true); assert.ok(o.config.equals(config)); assert.ok(o.user.equals(user.publicKey));
  assert.equal(BigInt(o.nonce.toString()), nonce); assert.equal(BigInt(o.cashAmount.toString()), cash);
  assert.equal(BigInt(o.minimumShares.toString()), quantity); assert.deepEqual(o.market, c.market); assert.equal(o.outcome, c.outcome);
  assert.deepEqual(o.orderId, [...hashes().orderId]); assert.deepEqual(o.termsHash, [...hashes().termsHash]);
  assert.ok(o.userCashAta.equals(userCash)); assert.ok(o.userYesAta.equals(userYes)); assert.ok(o.escrow.equals(escrow));
  assert.equal(o.bump, orderBump); assert.equal(o.escrowBump, escrowBump);
  if (refunded) {
    assert.ok(o.acceptedReceipt); assert.equal(o.acceptedReceipt.terminal, 2);
    assert.equal(BigInt(o.acceptedReceipt.filledQuantity.toString()), 0n);
    assert.deepEqual(o.acceptedReceipt.receiptHash, [...hashes().receiptHash]);
  } else assert.equal(o.acceptedReceipt, null);
  const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(1n);
  assert.deepEqual((await info(userNonce)).data, Buffer.concat([sha(Buffer.from("account:UserNonce")).subarray(0, 8),
    config.toBuffer(), user.publicKey.toBuffer(), nonceBytes, Buffer.from([nonceBump])]));
  const encodedCash = Buffer.alloc(8); encodedCash.writeBigUInt64LE(cash);
  const encodedMinimum = Buffer.alloc(8); encodedMinimum.writeBigUInt64LE(quantity);
  const encodedNonce = Buffer.alloc(8); encodedNonce.writeBigUInt64LE(nonce);
  const encodedReceipt = refunded ? Buffer.concat([Buffer.from([1, 2]), Buffer.alloc(8), hashes().receiptHash,
    Buffer.from([orderBump, escrowBump])]) : Buffer.from([0, orderBump, escrowBump]);
  const expectedOrder = Buffer.alloc(335);
  Buffer.concat([sha(Buffer.from("account:Order")).subarray(0, 8), config.toBuffer(), user.publicKey.toBuffer(), encodedNonce,
    Buffer.from(c.market), Buffer.from([c.outcome]), encodedCash, encodedMinimum, hashes().orderId, hashes().termsHash,
    userCash.toBuffer(), userYes.toBuffer(), escrow.toBuffer(), Buffer.from([refunded ? 3 : 1, 1]), encodedReceipt]).copy(expectedOrder);
  assert.deepEqual((await info(order)).data, expectedOrder, "Complete independently encoded permanent order layout");
  const n = await program.account.userNonce.fetch(userNonce, "finalized");
  assert.ok(n.config.equals(config)); assert.ok(n.user.equals(user.publicKey)); assert.equal(n.bump, nonceBump);
  assert.equal(BigInt(n.nextNonce.toString()), 1n);
}
async function tokenKeys(mint: PublicKey) {
  return (await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { commitment: "finalized", minContextSlot: latestSlot,
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] })).map(({ pubkey }) => pubkey);
}
async function conservation() {
  const checks = [];
  for (const mint of [c.cashMint, c.yesMint]) {
    const keys = await tokenKeys(mint);
    assert.ok(keys.every((key) => tracked.has(key.toBase58())), "Every configured-mint token balance is exported/tracked");
    let sum = 0n; const balances = [];
    for (const key of keys) { const value = await amount(key); sum += value; balances.push({ key: key.toBase58(), amount: value.toString() }); }
    const mintSupply = await supply(mint);
    assert.equal(mintSupply, sum, "Mint supply reconciles independently against all token accounts");
    checks.push({ mint: mint.toBase58(), supply: mintSupply.toString(), sum: sum.toString(), balances });
  }
  (evidence.conservation as unknown[]).push({ phase, slot: latestSlot, checks }); saveEvidence();
}
async function validateBindings() {
  for (const [key, size] of [[config, 580], [accounting, 105], [userNonce, 81], [order, 335]] as const) {
    const raw = await info(key); assert.ok(raw.owner.equals(programId)); assert.equal(raw.data.length, size); assert.equal(raw.executable, false);
    const name = key.equals(config) ? "Config" : key.equals(accounting) ? "Accounting" : key.equals(userNonce) ? "UserNonce" : "Order";
    assert.deepEqual(raw.data.subarray(0, 8), sha(Buffer.from(`account:${name}`)).subarray(0, 8));
  }
  for (const bytes of [c.sourceDomain, c.destinationDomain, c.chainId, c.market, c.settlement, c.venue,
    c.cashToken, c.yesToken, c.evmOperator, c.evmExecutor]) assert.ok(bytes.some((byte) => byte !== 0));
  assert.notDeepEqual(c.sourceDomain, c.destinationDomain); assert.notDeepEqual(c.cashToken, c.yesToken);
  assert.notDeepEqual(c.evmOperator, c.evmExecutor);
  assert.ok(!user.publicKey.equals(c.solanaOperator) && !user.publicKey.equals(c.solanaExecutor));
  assert.equal(c.version, 1); assert.equal(c.outcome, 0); assert.equal(c.bump, configBump); assert.equal(c.yesAuthorityBump, yesBump);
  assert.ok(c.solanaProgram.equals(programId)); assert.ok(c.solanaOperator.equals(operator.publicKey));
  assert.ok(c.yesMintAuthority.equals(yesAuthority)); assert.ok(c.tokenProgram.equals(TOKEN_PROGRAM_ID));
  assert.ok(c.associatedTokenProgram.equals(ASSOCIATED_TOKEN_PROGRAM_ID)); assert.ok(c.systemProgram.equals(SystemProgram.programId));
  assert.ok(!c.cashMint.equals(c.yesMint)); assert.ok(!c.solanaExecutor.equals(operator.publicKey));
  assert.ok(c.executorCashAta.equals(getAssociatedTokenAddressSync(c.cashMint, c.solanaExecutor)));
  for (const mint of [c.cashMint, c.yesMint]) {
    const raw = await info(mint); assert.equal(raw.data.length, 82); assert.ok(raw.owner.equals(TOKEN_PROGRAM_ID));
    const m = unpackMint(mint, raw); assert.equal(m.decimals, 6); assert.equal(m.isInitialized, true); assert.equal(m.freezeAuthority, null);
    assert.ok(m.mintAuthority?.equals(mint.equals(c.yesMint) ? yesAuthority : cashAuthority.publicKey));
  }
  for (const [key, mint, owner] of [[escrow, c.cashMint, order], [userCash, c.cashMint, user.publicKey],
    [userYes, c.yesMint, user.publicKey], [c.executorCashAta, c.cashMint, c.solanaExecutor]] as const) {
    const raw = await info(key); assert.equal(raw.data.length, 165); assert.ok(raw.owner.equals(TOKEN_PROGRAM_ID));
    const a = unpackAccount(key, raw); assert.ok(a.mint.equals(mint)); assert.ok(a.owner.equals(owner));
    assert.equal(a.isInitialized, true); assert.equal(a.isFrozen, false); assert.equal(a.delegate, null); assert.equal(a.closeAuthority, null);
    assert.equal(a.delegatedAmount, 0n); assert.equal(a.isNative, false); assert.equal(a.rentExemptReserve, null);
  }
  for (const key of [user.publicKey, operator.publicKey, feePayer.publicKey, cashAuthority.publicKey, c.solanaExecutor]) {
    const raw = await info(key); assert.ok(raw.owner.equals(SystemProgram.programId)); assert.equal(raw.data.length, 0); assert.equal(raw.executable, false);
  }
  const executable = await info(programId); const data = await info(programData);
  assert.ok(executable.owner.equals(loader)); assert.equal(executable.executable, true); assert.equal(executable.data.length, 36);
  assert.equal(executable.data.readUInt32LE(), 2); assert.ok(new PublicKey(executable.data.subarray(4, 36)).equals(programData));
  assert.ok(data.owner.equals(loader)); assert.equal(data.executable, false); assert.equal(data.data.readUInt32LE(), 3);
  assert.equal(data.data[12], 0, "Upgrade authority remains None");
  const artifact = readFileSync(join(root, "solana/target/deploy/settlement_lab.so"));
  assert.deepEqual(data.data.subarray(45, 45 + artifact.length), artifact, "The exact compiled SBF bytes execute");
  assert.ok(data.data.subarray(45 + artifact.length).every((byte) => byte === 0));
  assert.equal(sha(artifact).toString("hex"), evidence.artifactSha256);
  const a = await program.account.accounting.fetch(accounting, "finalized");
  const u128max = (1n << 128n) - 1n;
  const refunded = BigInt(a.totalRefunded.toString()); const reimbursed = BigInt(a.totalReimbursed.toString());
  assert.ok(refunded + cash <= u128max && refunded + cash + reimbursed <= u128max);
  assert.ok(refunded + cash + reimbursed <= BigInt(a.totalDeposited.toString()), "Every refund Accounting check has capacity");
  assert.ok(await amount(userCash) + cash <= (1n << 64n) - 1n, "Recipient capacity cannot cause failure");
  assert.equal(await supply(c.yesMint), 0n); assert.equal(await amount(userYes), 0n);
  await verifyOrder(); await verifyAccounting(); await conservation();
}

test(`actual SBF refund transfer rollback: ${phase}`, { timeout: 850_000 }, async (t) => {
  c = await program.account.config.fetch(config, "finalized");
  userCash = getAssociatedTokenAddressSync(c.cashMint, user.publicKey);
  userYes = getAssociatedTokenAddressSync(c.yesMint, user.publicKey);
  track(config, accounting, userNonce, order, c.cashMint, c.yesMint, escrow, userCash, userYes, c.executorCashAta,
    programId, programData, user.publicKey, operator.publicKey, cashAuthority.publicKey, c.solanaExecutor);
  if (phase === "prepare") {
    await t.test("fund separate identities and create a genuine deposited order", async () => {
      const supplyBefore = await supply(c.cashMint);
      success(await submit("fund fixture", [
        SystemProgram.transfer({ fromPubkey: cashAuthority.publicKey, toPubkey: feePayer.publicKey, lamports: 10_000_000_000 }),
        SystemProgram.transfer({ fromPubkey: cashAuthority.publicKey, toPubkey: user.publicKey, lamports: 1_000_000_000 }),
        SystemProgram.transfer({ fromPubkey: cashAuthority.publicKey, toPubkey: operator.publicKey, lamports: 1_000_000 }),
        SystemProgram.transfer({ fromPubkey: cashAuthority.publicKey, toPubkey: c.solanaExecutor, lamports: 1_000_000 }),
        createAssociatedTokenAccountInstruction(cashAuthority.publicKey, userCash, user.publicKey, c.cashMint),
        createAssociatedTokenAccountInstruction(cashAuthority.publicKey, userYes, user.publicKey, c.yesMint),
        createMintToInstruction(c.cashMint, userCash, cashAuthority.publicKey, cash),
      ], [], cashAuthority));
      assert.equal(await amount(userCash), cash); assert.equal(await supply(c.cashMint), supplyBefore + cash);
      assert.equal(await supply(c.yesMint), 0n); assert.equal(await amount(userYes), 0n);
      const before = await info(accounting); assert.ok(before.data.subarray(40, 104).every((byte) => byte === 0));
      const ix = await program.methods.createOrder({ nonce: bn(nonce), cashAmount: bn(cash), minimumShares: bn(quantity) }).accountsStrict({
        user: user.publicKey, config, accounting, userNonce, order, cashMint: c.cashMint, yesMint: c.yesMint,
        userCashAta: userCash, userYesAta: userYes, escrow, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
      success(await submit("create order", [ix], [user]));
      await verifyAccounting(); assert.equal(await amount(escrow), cash); assert.equal(await amount(userCash), 0n);
    });
    await t.test("original user's cancellation changes only lifecycle bytes", async () => {
      const before = await snapshot();
      const result = await submit("request cancellation", [await program.methods.requestCancel(bn(nonce), [...hashes().termsHash])
        .accountsStrict({ user: user.publicKey, config, order }).instruction()], [user]); success(result);
      const message = result.receipt.transaction.message;
      assert.ok(message.staticAccountKeys.some((key, i) => key.equals(user.publicKey) && message.isAccountSigner(i)));
      edit(before, order, (bytes) => { bytes[289] = 1; bytes[290] = 1; });
      assert.deepEqual(await snapshot(), before); await verifyOrder(); await verifyAccounting();
      assert.equal(await supply(c.yesMint), 0n); assert.equal(await amount(userYes), 0n);
    });
    await t.test("validate immutable SBF and export the complete finalized fixture manifest", async () => {
      for (const mint of [c.cashMint, c.yesMint]) track(...await tokenKeys(mint));
      await validateBindings(); assert.equal(await amount(escrow), cash);
      const manifest: Manifest = { keys: [...tracked.keys(), feePayer.publicKey.toBase58()], cashMint: c.cashMint.toBase58(),
        yesMint: c.yesMint.toBase58(), escrow: escrow.toBase58(), feePayer: feePayer.publicKey.toBase58(), preparationSlot: latestSlot };
      writeFileSync(join(runtime!, "cancelled-rollback-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      evidence.preparation = { ledger: "ledger", slot: latestSlot, escrow: cash.toString(), cashSupply: (await supply(c.cashMint)).toString(),
        yesSupply: "0", state: "CancelRequested", cancellationRequested: true, nextNonce: "1", snapshot: await snapshot() };
      saveEvidence();
    });
    return;
  }

  const manifest: Manifest = JSON.parse(readFileSync(join(runtime!, "cancelled-rollback-manifest.json"), "utf8"));
  assert.equal(manifest.feePayer, feePayer.publicKey.toBase58());
  for (const key of manifest.keys) if (key !== manifest.feePayer) track(new PublicKey(key));
  function dumps(directory: string): Snapshot {
    return [...tracked.keys()].map((key) => {
      const dump: Dump = exactMetadataJson(readFileSync(join(runtime!, directory, `${key}.json`), "utf8"));
      assert.equal(dump.pubkey, key); assert.equal(dump.account.data[1], "base64");
      return { key, account: { owner: dump.account.owner, lamports: dump.account.lamports,
        executable: dump.account.executable, rentEpoch: dump.account.rentEpoch, space: dump.account.space, data: Buffer.from(dump.account.data[0], "base64").toString("hex") } };
    });
  }
  const original = dumps("cancelled-rollback-original");
  let refundIx: TransactionInstruction;
  await t.test("new ledger matches exactly the two intended genesis alterations", async () => {
    assert.equal(latestSlot, 0, "Preparation observation context was discarded");
    assert.deepEqual(original, (evidence.preparation as { snapshot: Snapshot }).snapshot);
    const intended = structuredClone(original);
    edit(intended, escrow, (bytes) => { assert.equal(bytes.readBigUInt64LE(64), cash); bytes.writeBigUInt64LE(cash - 1n, 64); });
    edit(intended, c.cashMint, (bytes) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(36) - 1n, 36));
    assert.deepEqual(dumps("cancelled-rollback-altered"), intended); assert.deepEqual(await snapshot(), intended);
    const payerDump: Dump = exactMetadataJson(readFileSync(join(runtime!, "cancelled-rollback-altered", `${manifest.feePayer}.json`), "utf8"));
    const payer = (await snapshot([feePayer.publicKey]))[0].account;
    assert.deepEqual(payer, { owner: payerDump.account.owner, lamports: payerDump.account.lamports,
      executable: payerDump.account.executable, rentEpoch: payerDump.account.rentEpoch, space: payerDump.account.space,
      data: Buffer.from(payerDump.account.data[0], "base64").toString("hex") });
    await validateBindings(); assert.equal(await amount(escrow), cash - 1n);
    evidence.loadedSnapshot = await snapshot();
    evidence.loadedSnapshotMatches = true; evidence.cashConservationPreserved = true;
    evidence.preSubmission = { state: "CancelRequested", cancellationRequested: true, acceptedReceipt: null,
      escrow: (cash - 1n).toString(), requiredRefund: cash.toString(), userCash: "0", refundCounter: "0",
      accountingAndRecipientCapacityVerified: true, termsHash: hashes().termsHash.toString("hex"),
      receipt: { terminal: 2, filledQuantity: "0", receiptHash: hashes().receiptHash.toString("hex") } };
    refundIx = await refundInstruction(); evidence.refundInstructionHex = refundIx.data.toString("hex"); saveEvidence();
  });
  assert.ok(refundIx!, "Loaded fixture validation must pass before submitting a receipt");
  await t.test("refund TransferChecked fails and every tracked byte and metadata value is preserved", async () => {
    const before = await snapshot(); const result = await submit("refund CPI insufficient funds", [refundIx], [operator]);
    verifyCpis(result, true); assert.deepEqual(await snapshot(), before);
    await verifyOrder(); await verifyAccounting(); await conservation();
    assert.equal(await supply(c.yesMint), 0n); assert.equal(await amount(userYes), 0n);
    assert.equal(await amount(escrow), cash - 1n);
    evidence.failureProof = { signature: result.signature, snapshotPreserved: true, refundInsufficientFunds: true, cpiCount: 1, events: 0, before, after: await snapshot() }; saveEvidence();
  });
  assert.ok(evidence.failureProof, "The exact refund-CPI rollback proof must pass before restoration");
  await t.test("authorized SPL cash mint restores exactly the missing unit", async () => {
    const before = await snapshot(); const expected = structuredClone(before);
    edit(expected, escrow, (bytes) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(64) + 1n, 64));
    edit(expected, c.cashMint, (bytes) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(36) + 1n, 36));
    const result = await submit("fixture restoration: SPL MintTo one cash unit", [
      createMintToInstruction(c.cashMint, escrow, cashAuthority.publicKey, 1n),
    ], [cashAuthority]); success(result);
    assert.deepEqual(await snapshot(), expected); assert.deepEqual(await snapshot(), original);
    assert.equal(await amount(escrow), cash); await verifyOrder(); await verifyAccounting(); await conservation();
    evidence.restoration = { signature: result.signature, before, expected, after: await snapshot(), originalSnapshotRestored: true, method: "Authorized legacy SPL MintTo, one cash unit" }; saveEvidence();
  });
  assert.ok(evidence.restoration, "Fixture restoration must pass before retry");
  await t.test("identical receipt refunds once with exact counters, balances and retained history", async () => {
    assert.deepEqual(await refundInstruction(), refundIx);
    const before = await snapshot(); const expected = structuredClone(before);
    const beforeSupply = await supply(c.yesMint); const beforeExecutor = await amount(c.executorCashAta);
    const beforeCash = await amount(userCash);
    const result = await submit("identical Cancelled retry", [refundIx], [operator]); success(result); verifyCpis(result, false);
    const failureTx = (evidence.transactions as { name: string; signature: string; blockhash: string }[])
      .find((tx) => tx.name === "refund CPI insufficient funds"); assert.ok(failureTx);
    assert.notEqual(result.signature, failureTx.signature); assert.notEqual(result.blockhash, failureTx.blockhash);
    assert.equal(result.events.length, 1); assert.equal(result.events[0].name, "cancelledAccepted");
    const event = result.events[0].data as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), ["order", "termsHash", "receiptHash", "cashAmount"].sort());
    assert.ok(event.order instanceof PublicKey && event.order.equals(order));
    assert.deepEqual(event.termsHash, [...hashes().termsHash]); assert.deepEqual(event.receiptHash, [...hashes().receiptHash]);
    assert.equal(String(event.cashAmount), cash.toString());
    edit(expected, accounting, (bytes) => u128le(cash).copy(bytes, 56));
    edit(expected, escrow, (bytes) => bytes.writeBigUInt64LE(0n, 64));
    edit(expected, userCash, (bytes) => bytes.writeBigUInt64LE(beforeCash + cash, 64));
    edit(expected, order, (bytes) => {
      assert.equal(bytes[289], 1); assert.equal(bytes[290], 1); assert.equal(bytes[291], 0);
      const bumps = Buffer.from(bytes.subarray(292, 294)); bytes[289] = 3; bytes[291] = 1; bytes[292] = 2;
      bytes.writeBigUInt64LE(0n, 293); hashes().receiptHash.copy(bytes, 301); bumps.copy(bytes, 333);
    });
    const after = await snapshot(); assert.deepEqual(after, expected);
    await verifyOrder(true); await verifyAccounting(cash); await conservation();
    assert.equal(await amount(userCash), beforeCash + cash); assert.equal(await amount(escrow), 0n);
    assert.equal(await supply(c.yesMint), beforeSupply); assert.equal(await amount(userYes), 0n);
    assert.equal(await amount(c.executorCashAta), beforeExecutor);
    evidence.retry = { signature: result.signature, cpiCount: 1, events: 1, exactSnapshotDelta: true,
      before, expected, after, receiptHash: hashes().receiptHash.toString("hex"), cancellationHistoryRetained: true }; saveEvidence();
  });
  assert.ok(evidence.retry, "The successful identical receipt must pass before replay");
  await t.test("exact successful receipt replay has no CPI, event or economic effect", async () => {
    const before = await snapshot(); assert.deepEqual(await refundInstruction(), refundIx);
    const result = await submit("exact Cancelled replay", [refundIx], [operator]); success(result);
    assert.equal(result.receipt.meta!.innerInstructions?.length ?? 0, 0);
    assert.ok(!(result.receipt.meta!.logMessages ?? []).some((line) => /invoke \[[2-9]/.test(line)));
    assert.equal(result.events.length, 0); assert.ok(!(result.receipt.meta!.logMessages ?? []).some((line) => line.startsWith("Program data:")));
    assert.deepEqual(await snapshot(), before); await verifyOrder(true); await verifyAccounting(cash); await conservation();
    evidence.replay = { signature: result.signature, before, after: await snapshot(), cpiCount: 0, events: 0, snapshotPreserved: true };
    evidence.complete = true; saveEvidence();
  });
});
