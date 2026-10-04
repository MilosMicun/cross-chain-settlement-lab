import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import {
  ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, MINT_SIZE,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createApproveInstruction,
  createAssociatedTokenAccountInstruction, createFreezeAccountInstruction,
  createInitializeAccountInstruction, createInitializeMintInstruction,
  createMintToInstruction, createRevokeInstruction, createSetAuthorityInstruction,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type ParsedInstruction, type PartiallyDecodedInstruction, type TransactionInstruction,
} from "@solana/web3.js";

const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.INITIALIZATION_RUNTIME;
assert.ok(runtime, "Use scripts/check-solana-initialization.sh with a fresh local validator");
const authorityPath = join(runtime, "deployment-authority.json");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath, "utf8"))));
const unrelatedProgram = new PublicKey(process.env.INITIALIZATION_UNRELATED_PROGRAM!);
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "finalized" });
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, provider);
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
assert.ok(program.programId.equals(programId));
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
const [unrelatedData] = PublicKey.findProgramAddressSync([unrelatedProgram.toBuffer()], loader);
const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
const executor = Keypair.generate();
const operator = Keypair.generate();
// Share only this local fixture credential with the later operator-signed suite.
writeFileSync(join(runtime, "operator-fixture.json"), JSON.stringify([...operator.secretKey]) + "\n", { mode: 0o600 });
const wrongSigner = Keypair.generate();
const tracked: PublicKey[] = [];
let latestSlot = 0;
const bytes = (width: number, value: number) => Array<number>(width).fill(value);
const chainId = bytes(32, 0);
chainId[30] = 0x7a;
chainId[31] = 0x69;
const args = {
  sourceDomain: bytes(32, 0x11), destinationDomain: bytes(32, 0x22), chainId,
  settlement: bytes(20, 0x44), venue: bytes(20, 0x45), cashToken: bytes(20, 0x46),
  yesToken: bytes(20, 0x47), evmOperator: bytes(20, 0x48), evmExecutor: bytes(20, 0x49),
  market: bytes(32, 0x66), solanaOperator: operator.publicKey, solanaExecutor: executor.publicKey,
};

async function submit(instructions: TransactionInstruction[], signers: Keypair[] = [], payer = authority) {
  const block = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({ ...block, feePayer: payer.publicKey }).add(...instructions);
  const unique = [...new Map([payer, ...signers].map((signer) => [signer.publicKey.toBase58(), signer])).values()];
  transaction.sign(...unique);
  // Skip preflight so rejection evidence comes from an executed ledger transaction.
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
  // Poll statuses explicitly: web3's confirmation helper may throw a transaction
  // error before returning finalized metadata for deliberately rejected calls.
  const deadline = Date.now() + 90_000;
  let status;
  while (Date.now() < deadline) {
    status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.confirmationStatus === "finalized") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.confirmationStatus, "finalized", `Finalization deadline exceeded: ${signature}`);
  const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  assert.ok(receipt?.meta, `Missing finalized transaction metadata: ${signature}`);
  assert.deepEqual(receipt.meta.err, status.err);
  latestSlot = Math.max(latestSlot, receipt.slot);
  return { signature, receipt };
}

async function setup(instructions: TransactionInstruction[], signers: Keypair[] = []) {
  const result = await submit(instructions, signers);
  assert.equal(result.receipt.meta!.err, null, JSON.stringify(result.receipt.meta!.logMessages));
}

async function mint(options: { decimals?: number; freeze?: PublicKey; mintAuthority?: PublicKey; supply?: bigint; token2022?: boolean } = {}) {
  const key = Keypair.generate();
  const tokenProgram = options.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  await setup([
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: key.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: tokenProgram }),
    createInitializeMintInstruction(key.publicKey, options.decimals ?? 6, options.mintAuthority ?? authority.publicKey, options.freeze ?? null, tokenProgram),
  ], [key]);
  tracked.push(key.publicKey);
  if (options.supply) {
    const recipient = await tokenAccount(key.publicKey, authority.publicKey, true);
    await setup([createMintToInstruction(key.publicKey, recipient, authority.publicKey, options.supply)]);
  }
  return key.publicKey;
}

async function tokenAccount(mintKey: PublicKey, owner: PublicKey, canonical: boolean) {
  if (canonical) {
    const ata = getAssociatedTokenAddressSync(mintKey, owner);
    await setup([createAssociatedTokenAccountInstruction(authority.publicKey, ata, owner, mintKey)]);
    tracked.push(ata);
    return ata;
  }
  const key = Keypair.generate();
  await setup([
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: key.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccountInstruction(key.publicKey, mintKey, owner),
  ], [key]);
  tracked.push(key.publicKey);
  return key.publicKey;
}

async function state() {
  const accounts = await connection.getMultipleAccountsInfo(tracked, { commitment: "finalized", minContextSlot: latestSlot });
  return accounts.map((account, index) => {
    assert.ok(account, `Missing fixture account ${tracked[index]}`);
    return { owner: account.owner.toBase58(), data: account.data.toString("hex") };
  });
}

type Bindings = {
  initializer: PublicKey; program: PublicKey; programData: PublicKey; config: PublicKey; accounting: PublicKey;
  cashMint: PublicKey; yesMint: PublicKey; executorCashAta: PublicKey;
  tokenProgram: PublicKey; associatedTokenProgram: PublicKey; systemProgram: PublicKey;
};
let bindings: Bindings;
let cashMint: PublicKey;
let yesMint: PublicKey;
let reimbursement: PublicKey;
let preservedConfig: Buffer;
let preservedAccounting: Buffer;
let preservedTokens: Awaited<ReturnType<typeof state>>;
const evidence: { name: string; signature: string; error: unknown }[] = [];

async function initializeInstruction(changes: Partial<typeof args> = {}, accountChanges: Partial<Bindings> = {}) {
  return program.methods.initialize({ ...args, ...changes }).accountsStrict({ ...bindings, ...accountChanges }).instruction();
}

async function rejected(name: string, expected: string, changes: Partial<typeof args> = {}, accountChanges: Partial<Bindings> = {}, signer = authority, nonSigning = false, existing = false) {
  const before = await state();
  const beforeConfig = await connection.getAccountInfo(config, { commitment: "finalized", minContextSlot: latestSlot });
  const beforeAccounting = await connection.getAccountInfo(accounting, { commitment: "finalized", minContextSlot: latestSlot });
  assert.equal(beforeConfig !== null, existing);
  assert.equal(beforeAccounting !== null, existing);
  const ix = await initializeInstruction(changes, accountChanges);
  if (nonSigning) {
    const key = ix.keys.find((meta) => meta.pubkey.equals(authority.publicKey));
    assert.ok(key);
    key.isSigner = false;
  }
  const { signature, receipt } = await submit([ix], nonSigning ? [] : [signer], nonSigning ? wrongSigner : signer);
  assert.notEqual(receipt.meta!.err, null, `${name}: transaction unexpectedly succeeded`);
  const logs = receipt.meta!.logMessages ?? [];
  assert.ok(logs.some((line) => line === `Program ${programId} invoke [1]`), `${name}: application was not invoked`);
  assert.ok(logs.some((line) => line.includes(expected)), `${name}: expected ${expected}; ${JSON.stringify(logs)}`);
  const error = receipt.meta!.err as { InstructionError?: [number, unknown] };
  assert.equal(error.InstructionError?.[0], 0, `${name}: failure must be in initialize`);
  const afterConfig = await connection.getAccountInfo(config, { commitment: "finalized", minContextSlot: latestSlot });
  const afterAccounting = await connection.getAccountInfo(accounting, { commitment: "finalized", minContextSlot: latestSlot });
  if (existing) {
    assert.ok(afterConfig && beforeConfig);
    assert.deepEqual(afterConfig, beforeConfig);
    assert.deepEqual(afterAccounting, beforeAccounting);
  } else {
    assert.equal(afterConfig, null, `${name}: failed transaction created Config`);
    assert.equal(afterAccounting, null, `${name}: failed transaction created Accounting`);
  }
  if (accountChanges.accounting && !accountChanges.accounting.equals(accounting)) {
    assert.equal(await connection.getAccountInfo(accountChanges.accounting, "finalized"), null);
  }
  assert.deepEqual(await state(), before, `${name}: token data/supply/balances changed`);
  evidence.push({ name, signature, error: receipt.meta!.err });
}

test("actual SBF one-time initialization", { timeout: 850_000 }, async (t) => {
  await t.test("prepare real SPL fixtures and verify linked upgrade authority", async () => {
    await setup([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wrongSigner.publicKey, lamports: 2_000_000_000 })]);
    const executable = await connection.getAccountInfo(programId, "finalized");
    assert.ok(executable?.executable);
    assert.ok(executable.owner.equals(loader));
    assert.equal(executable.data.readUInt32LE(0), 2);
    assert.ok(new PublicKey(executable.data.subarray(4, 36)).equals(programData));
    const data = await connection.getAccountInfo(programData, "finalized");
    assert.ok(data);
    assert.ok(data.owner.equals(loader));
    assert.equal(data.data.readUInt32LE(0), 3);
    assert.equal(data.data[12], 1);
    assert.ok(new PublicKey(data.data.subarray(13, 45)).equals(authority.publicKey));
    const unrelated = await connection.getAccountInfo(unrelatedData, "finalized");
    assert.ok(unrelated);
    assert.ok(unrelated.owner.equals(loader));
    assert.ok(new PublicKey(unrelated.data.subarray(13, 45)).equals(authority.publicKey));
    cashMint = await mint();
    yesMint = await mint({ mintAuthority: yesAuthority });
    reimbursement = await tokenAccount(cashMint, executor.publicKey, true);
    await setup([createMintToInstruction(cashMint, reimbursement, authority.publicKey, 10_000_000n)]);
    bindings = { initializer: authority.publicKey, program: programId, programData, config, accounting,
      cashMint, yesMint, executorCashAta: reimbursement, tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  });

  await t.test("reject funded first-caller takeover", () => rejected("first-caller takeover", "UnauthorizedInitializer", {}, { initializer: wrongSigner.publicKey }, wrongSigner));
  await t.test("reject authority supplied without signature and separate fee payer", () => rejected("non-signing authority", "AccountNotSigner", {}, {}, authority, true));
  await t.test("reject wrong executable program", () => rejected("wrong executable", "InvalidProgramId", {}, { program: unrelatedProgram }));
  await t.test("reject unrelated ProgramData naming the same authority", () => rejected("unlinked ProgramData", "UnlinkedProgramData", {}, { programData: unrelatedData }));
  await t.test("reject noncanonical Config address", () => rejected("wrong Config seeds", "ConstraintSeeds", {}, { config: wrongSigner.publicKey }));
  await t.test("reject noncanonical Accounting address atomically with Config", () => rejected(
    "wrong Accounting seeds", "ConstraintSeeds", {}, { accounting: Keypair.generate().publicKey }));
  await t.test("reject wrong-owner ProgramData", () => rejected("wrong-owner ProgramData", "AccountOwnedByWrongProgram", {}, { programData: cashMint }));
  await t.test("reject loader-owned non-ProgramData variant", () => rejected("wrong loader variant", "AccountNotProgramData", {}, { programData: programId }));
  await t.test("reject genuinely allocated malformed loader account", async () => {
    const malformed = Keypair.generate();
    await setup([SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: malformed.publicKey,
      space: 1, lamports: await connection.getMinimumBalanceForRentExemption(1), programId: loader })], [malformed]);
    await rejected("malformed ProgramData", "invalid account data", {}, { programData: malformed.publicKey });
  });

  const invalidArgs: [string, string, Partial<typeof args>][] = [
    ["zero source domain", "ZeroDomain", { sourceDomain: bytes(32, 0) }],
    ["zero destination domain", "ZeroDomain", { destinationDomain: bytes(32, 0) }],
    ["equal domains", "EqualDomains", { destinationDomain: args.sourceDomain }],
    ["zero full-width chain ID", "ZeroChainId", { chainId: bytes(32, 0) }],
    ["zero market", "ZeroMarket", { market: bytes(32, 0) }],
    ...(["settlement", "venue", "cashToken", "yesToken", "evmOperator", "evmExecutor"] as const).map((field): [string, string, Partial<typeof args>] =>
      [`zero EVM ${field}`, "ZeroEvmAddress", { [field]: bytes(20, 0) }]),
    ["equal EVM roles", "EqualEvmRoles", { evmExecutor: args.evmOperator }],
    ["equal EVM tokens", "EqualEvmTokens", { yesToken: args.cashToken }],
    ["zero Solana operator", "ZeroSolanaRole", { solanaOperator: PublicKey.default }],
    ["zero Solana executor", "ZeroSolanaRole", { solanaExecutor: PublicKey.default }],
    ["equal Solana roles", "EqualSolanaRoles", { solanaOperator: executor.publicKey }],
  ];
  for (const [name, expected, changes] of invalidArgs) {
    await t.test(`reject ${name}`, () => rejected(name, expected, changes));
  }
  await t.test("reject aliased source mints", () => rejected("same source mint", "EqualSourceMints", {}, { yesMint: cashMint }));
  for (const field of ["cashMint", "yesMint"]) {
    await t.test(`reject ${field} wrong decimals`, async () => {
      const key = await mint({ decimals: 9 });
      await rejected(`${field} decimals`, "WrongDecimals", {}, { [field]: key });
    });
    await t.test(`reject ${field} freeze authority`, async () => {
      const key = await mint({ freeze: authority.publicKey });
      await rejected(`${field} freeze authority`, "FreezeAuthority", {}, { [field]: key });
    });
  }
  await t.test("reject wrong YES mint authority", async () => {
    await rejected("wrong YES authority", "WrongYesAuthority", {}, { yesMint: await mint() });
  });
  await t.test("reject nonzero YES supply even with canonical authority", async () => {
    const key = await mint({ supply: 1n });
    await setup([createSetAuthorityInstruction(key, authority.publicKey, AuthorityType.MintTokens, yesAuthority)]);
    await rejected("nonzero YES supply", "NonzeroYesSupply", {}, { yesMint: key });
  });
  await t.test("reject uninitialized legacy mint", async () => {
    const key = Keypair.generate();
    await setup([SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: key.publicKey,
      space: MINT_SIZE, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), programId: TOKEN_PROGRAM_ID })], [key]);
    tracked.push(key.publicKey);
    await rejected("uninitialized mint", "UninitializedAccount", {}, { yesMint: key.publicKey });
  });
  await t.test("reject reimbursement with wrong owner", async () => {
    const key = await tokenAccount(cashMint, authority.publicKey, true);
    await rejected("wrong reimbursement owner", "WrongReimbursementOwner", {}, { executorCashAta: key });
  });
  await t.test("reject reimbursement with wrong mint", async () => {
    const key = await tokenAccount(yesMint, executor.publicKey, true);
    await rejected("wrong reimbursement mint", "WrongReimbursementMint", {}, { executorCashAta: key });
  });
  await t.test("reject noncanonical reimbursement address", async () => {
    const key = await tokenAccount(cashMint, executor.publicKey, false);
    await rejected("noncanonical reimbursement", "NoncanonicalReimbursement", {}, { executorCashAta: key });
  });
  await t.test("reject frozen canonical reimbursement account", async () => {
    const key = await mint({ freeze: authority.publicKey });
    const ata = await tokenAccount(key, executor.publicKey, true);
    await setup([createFreezeAccountInstruction(ata, key, authority.publicKey)]);
    // Remove the mint's freeze authority so the account-state check is exercised.
    await setup([createSetAuthorityInstruction(key, authority.publicKey, AuthorityType.FreezeAccount, null)]);
    await rejected("frozen reimbursement", "UnsafeReimbursementState", {}, { cashMint: key, executorCashAta: ata });
  });
  await t.test("reject reimbursement delegate", async () => {
    await setup([createApproveInstruction(reimbursement, operator.publicKey, executor.publicKey, 1n)], [executor]);
    await rejected("reimbursement delegate", "ReimbursementDelegate");
    await setup([createRevokeInstruction(reimbursement, executor.publicKey)], [executor]);
  });
  await t.test("reject reimbursement external close authority", async () => {
    await setup([createSetAuthorityInstruction(reimbursement, executor.publicKey, AuthorityType.CloseAccount, operator.publicKey)], [executor]);
    await rejected("reimbursement close authority", "ReimbursementCloseAuthority");
    await setup([createSetAuthorityInstruction(reimbursement, operator.publicKey, AuthorityType.CloseAccount, null)], [operator]);
  });
  for (const field of ["tokenProgram", "associatedTokenProgram", "systemProgram"]) {
    await t.test(`reject wrong executable ${field}`, () => rejected(`wrong ${field}`, "InvalidProgramId", {}, { [field]: unrelatedProgram }));
  }
  await t.test("reject Token-2022 program substitution", () => rejected("Token-2022 program", "InvalidProgramId", {}, { tokenProgram: TOKEN_2022_PROGRAM_ID }));
  await t.test("reject actual Token-2022 mint substitution", async () => {
    const key = await mint({ token2022: true });
    await rejected("Token-2022 mint", "AccountOwnedByWrongProgram", {}, { cashMint: key });
  });

  await t.test("initialize once and verify every immutable field, layout, rent, and token state", async () => {
    const before = await state();
    const { signature, receipt } = await submit([await initializeInstruction()]);
    assert.equal(receipt.meta!.err, null, JSON.stringify(receipt.meta!.logMessages));
    const account = await connection.getAccountInfo(config, { commitment: "finalized", minContextSlot: latestSlot });
    assert.ok(account);
    assert.ok(account.owner.equals(programId));
    assert.equal(account.executable, false);
    // Independent fixed-width Borsh layout, including the Anchor discriminator.
    const discriminator = createHash("sha256").update("account:Config").digest().subarray(0, 8);
    const expected = Buffer.concat([
      discriminator, Buffer.from([1]), Buffer.from(args.sourceDomain), Buffer.from(args.destinationDomain),
      programId.toBuffer(), Buffer.from(args.chainId), Buffer.from(args.settlement), Buffer.from(args.venue),
      Buffer.from(args.cashToken), Buffer.from(args.yesToken), Buffer.from(args.evmOperator), Buffer.from(args.evmExecutor),
      Buffer.from(args.market), Buffer.from([0]), operator.publicKey.toBuffer(), executor.publicKey.toBuffer(),
      cashMint.toBuffer(), yesMint.toBuffer(), reimbursement.toBuffer(), yesAuthority.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(), ASSOCIATED_TOKEN_PROGRAM_ID.toBuffer(), SystemProgram.programId.toBuffer(),
      Buffer.from([configBump, yesBump]),
    ]);
    assert.equal(expected.length, 580);
    assert.equal(account.data.length, 580);
    assert.deepEqual(account.data, expected);
    assert.equal(account.lamports, await connection.getMinimumBalanceForRentExemption(580, "finalized"));
    const ledger = await connection.getAccountInfo(accounting, { commitment: "finalized", minContextSlot: latestSlot });
    assert.ok(ledger);
    assert.ok(ledger.owner.equals(programId)); assert.equal(ledger.executable, false);
    const expectedAccounting = Buffer.concat([
      createHash("sha256").update("account:Accounting").digest().subarray(0, 8),
      config.toBuffer(), Buffer.alloc(64), Buffer.from([accountingBump]),
    ]);
    assert.equal(expectedAccounting.length, 105); assert.equal(ledger.data.length, 105);
    assert.deepEqual(ledger.data, expectedAccounting, "Independent all-zero u128 Accounting serialization");
    assert.equal(ledger.lamports, await connection.getMinimumBalanceForRentExemption(105, "finalized"));
    const parsed = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    assert.ok(parsed?.meta);
    for (const [address, rent] of [[config, account.lamports], [accounting, ledger.lamports]] as const) {
      const allocation: ParsedInstruction | PartiallyDecodedInstruction | undefined = parsed.meta.innerInstructions?.flatMap((entry) => entry.instructions).find((ix) =>
        "parsed" in ix && ix.program === "system" && ix.parsed.type === "createAccount" &&
        ix.parsed.info.newAccount === address.toBase58());
      assert.ok(allocation && "parsed" in allocation, "Real system CPI creates each permanent record");
      assert.equal(allocation.parsed.info.source, authority.publicKey.toBase58());
      assert.equal(allocation.parsed.info.lamports, rent, "Initializer pays exact rent for both records");
    }
    const counters = await program.account.accounting.fetch(accounting, "finalized");
    assert.ok(counters.config.equals(config)); assert.equal(counters.bump, accountingBump);
    for (const total of [counters.totalDeposited, counters.totalRefunded, counters.totalReimbursed, counters.totalSharesMinted]) {
      assert.equal(total.toString(), "0");
    }
    const fetched = await program.account.config.fetch(config, "finalized");
    for (const [field, expectedValue] of Object.entries(args)) {
      const actual = (fetched as Record<string, unknown>)[field];
      if (expectedValue instanceof PublicKey) assert.ok(actual instanceof PublicKey && actual.equals(expectedValue), field);
      else assert.deepEqual(actual, expectedValue, field);
    }
    const mintInfo = await connection.getAccountInfo(yesMint, "finalized");
    assert.ok(mintInfo);
    assert.equal(unpackMint(yesMint, mintInfo).supply, 0n);
    const cashInfo = await connection.getAccountInfo(reimbursement, "finalized");
    assert.ok(cashInfo);
    assert.equal(unpackAccount(reimbursement, cashInfo).amount, 10_000_000n);
    assert.deepEqual(await state(), before);
    preservedConfig = Buffer.from(account.data);
    preservedAccounting = Buffer.from(ledger.data);
    preservedTokens = await state();
    evidence.push({ name: "successful initialization", signature, error: null });
  });
  await t.test("reject identical initialization replay without overwriting", () => rejected("identical reinitialization", "already in use", {}, {}, authority, false, true));
  await t.test("reject changed initialization replay without overwriting", () => rejected("changed reinitialization", "already in use", { market: bytes(32, 0x77) }, {}, authority, false, true));
  await t.test("remove upgrade authority with genuine local loader CLI and preserve Config and Accounting", async () => {
    const result = await promisify(execFile)("solana", [
      "--config", join(runtime, "solana.yml"), "--url", connection.rpcEndpoint,
      "--keypair", authorityPath, "--commitment", "finalized",
      "program", "set-upgrade-authority", programId.toBase58(), "--upgrade-authority", authorityPath, "--final",
    ], { timeout: 60_000 });
    writeFileSync(join(runtime, "remove-authority.log"), result.stdout + result.stderr);
    const data = await connection.getAccountInfo(programData, "finalized");
    assert.ok(data);
    assert.ok(data.owner.equals(loader));
    assert.equal(data.data.readUInt32LE(0), 3);
    assert.equal(data.data[12], 0, "Upgrade authority must deserialize as None");
    const account = await connection.getAccountInfo(config, "finalized");
    assert.ok(account);
    assert.ok(account.owner.equals(programId));
    assert.deepEqual(account.data, preservedConfig);
    await program.account.config.fetch(config, "finalized");
    const ledger = await connection.getAccountInfo(accounting, "finalized"); assert.ok(ledger);
    assert.ok(ledger.owner.equals(programId)); assert.deepEqual(ledger.data, preservedAccounting);
    await program.account.accounting.fetch(accounting, "finalized");
    assert.deepEqual(await state(), preservedTokens);
    // Existing Config would mask the missing-authority branch on another initialize.
    writeFileSync(join(runtime, "evidence.json"), JSON.stringify({ programId: programId.toBase58(),
      config: config.toBase58(), configSpace: 580, accounting: accounting.toBase58(), accountingSpace: 105,
      totalDeposited: "0", totalRefunded: "0", totalReimbursed: "0", totalSharesMinted: "0", upgradeAuthority: null,
      rejectedTransactions: evidence.filter((entry) => entry.error !== null).length, transactions: evidence,
    }, null, 2) + "\n");
  });
});
