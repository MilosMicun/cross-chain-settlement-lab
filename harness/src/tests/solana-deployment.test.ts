import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo } from "@solana/web3.js";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";

const { initializeSolanaFixture } = await import(new URL("../solana-deployment.ts", import.meta.url).href) as typeof import("../solana-deployment.ts");
const { buildInitializeArgs } = await import(new URL("../solana-configuration.ts", import.meta.url).href) as typeof import("../solana-configuration.ts");

const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.SOLANA_DEPLOYMENT_RUNTIME;
assert.ok(runtime, "Use scripts/check-solana-deployment.sh --evm-manifest with a successful real EVM run");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
const authorityPath = join(runtime, "credentials/initializer.json");
function credential(name: string) {
  const path = join(runtime!, "credentials", `${name}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600, "Fixture credentials must be mode 0600");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const initializer = credential("initializer");
const operator = credential("operator");
const executor = credential("executor");
const cashMint = credential("cash-mint");
const yesMint = credential("yes-mint");
const rawManifest = readFileSync(join(runtime, "evm-deployment-manifest.json"));
const evm = JSON.parse(rawManifest.toString()) as EvmDeploymentManifest;
const connection = new Connection("http://127.0.0.1:18899", "finalized");
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
const program = new Program<SettlementLab>(idl, new AnchorProvider(connection, new Wallet(initializer), { commitment: "finalized" }));
assert.ok(program.programId.equals(programId));
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
const executorCashAta = getAssociatedTokenAddressSync(cashMint.publicKey, executor.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
const addresses = [config, accounting, cashMint.publicKey, yesMint.publicKey, executorCashAta];
const input = { connection, initializer, evmManifest: evm, programId, operator: operator.publicKey,
  executor: executor.publicKey, cashMint, yesMint };
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const hexBytes = (hex: string) => Buffer.from(hex.slice(2), "hex");
const chainBytes = Buffer.from(BigInt(evm.chainId).toString(16).padStart(64, "0"), "hex");
// Expected bytes are derived directly from input manifest/credentials and literal
// protocol layout, independently of the adapter, returned manifest and decoder.
const expectedConfig = Buffer.concat([
  discriminator("Config"), Buffer.from([1]), hexBytes(evm.sourceDomain), hexBytes(evm.destinationDomain),
  programId.toBuffer(), chainBytes, hexBytes(evm.contracts.settlement), hexBytes(evm.contracts.venue),
  hexBytes(evm.contracts.usd), hexBytes(evm.contracts.yes), hexBytes(evm.roles.operator), hexBytes(evm.roles.executor),
  hexBytes(evm.market), Buffer.from([0]), operator.publicKey.toBuffer(), executor.publicKey.toBuffer(),
  cashMint.publicKey.toBuffer(), yesMint.publicKey.toBuffer(), executorCashAta.toBuffer(), yesAuthority.toBuffer(),
  TOKEN_PROGRAM_ID.toBuffer(), ASSOCIATED_TOKEN_PROGRAM_ID.toBuffer(), SystemProgram.programId.toBuffer(),
  Buffer.from([configBump, yesBump]),
]);
const expectedAccounting = Buffer.concat([discriminator("Accounting"), config.toBuffer(), Buffer.alloc(64), Buffer.from([accountingBump])]);
let latestSlot = 0;
async function feePayerLamports(): Promise<bigint> {
  // Genesis SOL exceeds Number.MAX_SAFE_INTEGER. Preserve the RPC decimal token
  // instead of rounding it through web3's number-valued getBalance result.
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance",
      params: [initializer.publicKey.toBase58(), { commitment: "finalized", minContextSlot: latestSlot }] }),
  });
  assert.equal(response.ok, true);
  const raw = await response.text();
  const envelope = JSON.parse(raw);
  assert.equal(envelope.error, undefined); assert.ok(envelope.result.context.slot >= latestSlot);
  const values = [...raw.matchAll(/"value"\s*:\s*([0-9]+)(?=\s*[,}])/g)];
  assert.equal(values.length, 1, "Expected exactly one unsigned lamport balance in RPC result");
  return BigInt(values[0][1]);
}
async function accounts() {
  return connection.getMultipleAccountsInfo(addresses, { commitment: "finalized", minContextSlot: latestSlot });
}
function publicAccount(address: PublicKey, info: AccountInfo<Buffer> | null) {
  return info && { address: address.toBase58(), owner: info.owner.toBase58(), executable: info.executable,
    lamports: info.lamports, space: info.data.length, dataHex: info.data.toString("hex") };
}
async function snapshot() {
  return (await accounts()).map((info, index) => publicAccount(addresses[index], info));
}
async function checkMint(key: PublicKey, info: AccountInfo<Buffer>, authority: PublicKey) {
  assert.ok(info.owner.equals(TOKEN_PROGRAM_ID)); assert.equal(info.executable, false);
  assert.equal(info.data.length, MINT_SIZE);
  assert.equal(info.lamports, await connection.getMinimumBalanceForRentExemption(MINT_SIZE, "finalized"));
  const mint = unpackMint(key, info, TOKEN_PROGRAM_ID);
  assert.equal(mint.isInitialized, true); assert.equal(mint.decimals, 6); assert.equal(mint.supply, 0n);
  assert.ok(mint.mintAuthority?.equals(authority)); assert.equal(mint.freezeAuthority, null);
}
async function checkAta(info: AccountInfo<Buffer>) {
  assert.ok(info.owner.equals(TOKEN_PROGRAM_ID)); assert.equal(info.executable, false);
  assert.equal(info.data.length, ACCOUNT_SIZE);
  assert.equal(info.lamports, await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "finalized"));
  const ata = unpackAccount(executorCashAta, info, TOKEN_PROGRAM_ID);
  assert.ok(ata.owner.equals(executor.publicKey)); assert.ok(ata.mint.equals(cashMint.publicKey));
  assert.equal(ata.amount, 0n); assert.equal(ata.isInitialized, true); assert.equal(ata.isFrozen, false);
  assert.equal(ata.isNative, false); assert.equal(ata.delegate, null); assert.equal(ata.delegatedAmount, 0n);
  assert.equal(ata.closeAuthority, null);
}
async function finalized(signature: string, success: boolean) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.confirmationStatus === "finalized") {
      const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      assert.ok(receipt?.meta); assert.equal(receipt.slot, status.slot);
      assert.deepEqual(receipt.meta.err, status.err);
      assert.equal(receipt.meta.err === null, success, JSON.stringify(receipt.meta.logMessages));
      latestSlot = Math.max(latestSlot, receipt.slot);
      return receipt;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Finalized receipt deadline exceeded: ${signature}`);
}

test("real EVM manifest initializes the actual Solana fixture", { timeout: 550_000 }, async (t) => {
  const evidence: { inputManifestSha256: string; scope: string; checks: string[];
    observed: Record<string, unknown>; failure?: string } = {
    inputManifestSha256: createHash("sha256").update(rawManifest).digest("hex"),
    scope: "Source setup only; EVM manifest is prior verified deployment evidence, not a live destination proof",
    checks: [], observed: {},
  };
  const persist = () => writeFileSync(join(runtime, "solana-deployment-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    let failed = false;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); }
      catch (error) { failed = true; failure = error; throw error; }
    });
    if (failed) throw failure;
  }
  const originalSend = connection.sendRawTransaction.bind(connection);
  const sent: string[] = [];
  const intermediate: unknown[] = [];
  let captureSetup = false;
  connection.sendRawTransaction = async (...parameters: Parameters<Connection["sendRawTransaction"]>) => {
    if (captureSetup) {
      const step = sent.length;
      assert.ok(step < 4);
      if (step > 0) await finalized(sent[step - 1], true);
      const infos = await accounts();
      assert.equal(infos[0], null); assert.equal(infos[1], null);
      for (let index = 2; index < 5; index += 1) {
        assert.equal(infos[index] !== null, index < 2 + step, "Expected only earlier finalized setup accounts");
      }
      if (infos[2]) await checkMint(cashMint.publicKey, infos[2], initializer.publicKey);
      if (infos[3]) await checkMint(yesMint.publicKey, infos[3], yesAuthority);
      if (infos[4]) await checkAta(infos[4]);
      intermediate.push({ beforeStep: ["cashMint", "yesMint", "executorCashAta", "initialize"][step],
        minFinalizedSlot: latestSlot, accounts: await snapshot(),
        feePayerLamports: (await feePayerLamports()).toString() });
    }
    const signature = await originalSend(...parameters);
    sent.push(signature);
    return signature;
  };
  let manifest: SolanaDeploymentManifest;
  let preserved: Awaited<ReturnType<typeof snapshot>>;
  let programBefore: AccountInfo<Buffer>;
  let dataBefore: AccountInfo<Buffer>;
  try {
    await check("fresh canonical accounts and genuine linked SBF upgrade authority", async () => {
      assert.equal(expectedConfig.length, 580); assert.equal(expectedAccounting.length, 105);
      assert.deepEqual(await accounts(), [null, null, null, null, null]);
      const executable = await connection.getAccountInfo(programId, "finalized");
      assert.ok(executable?.executable); assert.ok(executable.owner.equals(loader));
      assert.equal(executable.data.length, 36); assert.equal(executable.data.readUInt32LE(0), 2);
      assert.ok(new PublicKey(executable.data.subarray(4, 36)).equals(programData));
      const data = await connection.getAccountInfo(programData, "finalized");
      assert.ok(data && !data.executable); assert.ok(data.owner.equals(loader));
      assert.equal(data.data.readUInt32LE(0), 3); assert.equal(data.data[12], 1);
      assert.ok(new PublicKey(data.data.subarray(13, 45)).equals(initializer.publicKey));
      const binary = readFileSync(join(root, "solana/target/deploy/settlement_lab.so"));
      assert.deepEqual(data.data.subarray(45, 45 + binary.length), binary);
      assert.ok(data.data.subarray(45 + binary.length).every((byte) => byte === 0));
      programBefore = executable; dataBefore = data;
      evidence.observed.loadedSbf = { programId: programId.toBase58(), programData: programData.toBase58(),
        binarySha256: createHash("sha256").update(binary).digest("hex"),
        loadedImageSha256: createHash("sha256").update(data.data.subarray(45)).digest("hex"),
        upgradeAuthority: initializer.publicKey.toBase58() };
    });
    await check("focused preflight failures send no transactions or allocate accounts", async () => {
      const before = await snapshot();
      const balance = await feePayerLamports();
      await assert.rejects(initializeSolanaFixture({ ...input, yesMint: cashMint }), /mint identities must be distinct/);
      await assert.rejects(initializeSolanaFixture({ ...input, initializer: operator }), /current upgrade authority/);
      await assert.rejects(initializeSolanaFixture({ ...input, evmManifest: { ...evm, chainId: "1" } }), /local chain ID 31337/);
      assert.equal(sent.length, 0); assert.deepEqual(await snapshot(), before);
      assert.equal(await feePayerLamports(), balance);
      evidence.observed.preflight = { rejectedAttempts: 3, transactionsSent: 0, unchangedState: true, unchangedFeePayer: true };
    });
    await check("four finalized setup transactions with independent intermediate empty token readbacks", async () => {
      const balanceBefore = await feePayerLamports();
      captureSetup = true;
      try { manifest = await initializeSolanaFixture(input); } finally { captureSetup = false; }
      assert.equal(sent.length, 4); assert.equal(intermediate.length, 4);
      let fees = 0;
      const receipts = [];
      for (const [step, transaction] of Object.entries(manifest.transactions)) {
        const receipt = await finalized(transaction.signature, true);
        assert.equal(receipt.slot, transaction.finalizedSlot);
        fees += receipt.meta!.fee;
        receipts.push({ step, signature: transaction.signature, finalizedSlot: receipt.slot, error: null, feeLamports: receipt.meta!.fee });
      }
      assert.deepEqual(Object.values(manifest.transactions).map((item) => item.signature), sent);
      const observed = await accounts(); assert.ok(observed.every((info) => info !== null));
      const rent = observed.reduce((sum, info) => sum + info!.lamports, 0);
      const balanceAfter = await feePayerLamports();
      assert.equal(balanceBefore - balanceAfter, BigInt(rent + fees), "Separate setup rent and transaction fees from zero protocol balances");
      evidence.observed.intermediateStates = intermediate;
      evidence.observed.setupTransactions = receipts;
      evidence.observed.setupSolAccounting = { balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString(), allocatedRentLamports: rent, feesLamports: fees };
      writeFileSync(join(runtime, "solana-deployment-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    });
    await check("every Config field, canonical PDA, ownership, discriminator, exact bytes and rent", async () => {
      const infos = await accounts(); const info = infos[0]; assert.ok(info);
      assert.ok(info.owner.equals(programId)); assert.equal(info.executable, false);
      assert.equal(info.data.length, 580); assert.deepEqual(info.data, expectedConfig);
      assert.equal(info.lamports, await connection.getMinimumBalanceForRentExemption(580, "finalized"));
      const stored = await program.account.config.fetch(config, "finalized");
      const fields = { version: 1, sourceDomain: Array.from(hexBytes(evm.sourceDomain)), destinationDomain: Array.from(hexBytes(evm.destinationDomain)),
        solanaProgram: programId, chainId: Array.from(chainBytes), settlement: Array.from(hexBytes(evm.contracts.settlement)),
        venue: Array.from(hexBytes(evm.contracts.venue)), cashToken: Array.from(hexBytes(evm.contracts.usd)),
        yesToken: Array.from(hexBytes(evm.contracts.yes)), evmOperator: Array.from(hexBytes(evm.roles.operator)),
        evmExecutor: Array.from(hexBytes(evm.roles.executor)), market: Array.from(hexBytes(evm.market)), outcome: 0,
        solanaOperator: operator.publicKey, solanaExecutor: executor.publicKey, cashMint: cashMint.publicKey, yesMint: yesMint.publicKey,
        executorCashAta, yesMintAuthority: yesAuthority, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        bump: configBump, yesAuthorityBump: yesBump };
      for (const [field, value] of Object.entries(fields)) {
        const actual = (stored as Record<string, unknown>)[field];
        if (value instanceof PublicKey) assert.ok(actual instanceof PublicKey && actual.equals(value), field);
        else assert.deepEqual(actual, value, field);
      }
      assert.equal(Object.keys(fields).length, Object.keys(stored).length, "Check every decoded Config field");
      assert.equal(manifest.accounts.config, config.toBase58());
      assert.equal(manifest.accounts.accounting, accounting.toBase58());
      assert.equal(manifest.accounts.yesMintAuthority, yesAuthority.toBase58());
      assert.equal(manifest.accounts.executorCashAta, executorCashAta.toBase58());
      assert.equal(manifest.programId, programId.toBase58()); assert.equal(manifest.programData, programData.toBase58());
      assert.deepEqual(manifest.roles, { initializer: initializer.publicKey.toBase58(), operator: operator.publicKey.toBase58(), executor: executor.publicKey.toBase58() });
      assert.deepEqual(manifest.bumps, { config: configBump, accounting: accountingBump, yesMintAuthority: yesBump });
      assert.deepEqual(manifest.deployment, { chainId: evm.chainId, sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
        solanaProgram: evm.solanaProgram, market: evm.market, outcome: evm.outcome, tokenDecimals: evm.tokenDecimals, roles: evm.roles, contracts: evm.contracts });
      assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest, "Public manifest serializes without client objects");
      evidence.observed.config = { ...publicAccount(config, info), expectedBytesSha256: createHash("sha256").update(expectedConfig).digest("hex"),
        independentBytesMatched: true, fullWidthChainIdHex: chainBytes.toString("hex"), checkedFields: Object.keys(fields) };
    });
    await check("Accounting exact 105-byte record, four zero u128 counters and rent", async () => {
      const info = (await accounts())[1]; assert.ok(info);
      assert.ok(info.owner.equals(programId)); assert.equal(info.executable, false);
      assert.equal(info.data.length, 105); assert.deepEqual(info.data, expectedAccounting);
      assert.equal(info.lamports, await connection.getMinimumBalanceForRentExemption(105, "finalized"));
      const decoded = await program.account.accounting.fetch(accounting, "finalized");
      assert.ok(decoded.config.equals(config)); assert.equal(decoded.bump, accountingBump);
      const counters: Record<string, string> = {};
      for (const [index, field] of ["totalDeposited", "totalRefunded", "totalReimbursed", "totalSharesMinted"].entries()) {
        const offset = 40 + index * 16;
        assert.equal(info.data.readBigUInt64LE(offset), 0n); assert.equal(info.data.readBigUInt64LE(offset + 8), 0n);
        const value = (decoded as unknown as Record<string, { toString(): string }>)[field].toString();
        assert.equal(value, "0"); counters[field] = value;
      }
      evidence.observed.accounting = { ...publicAccount(accounting, info), counters, independentBytesMatched: true };
    });
    await check("legacy six-decimal zero-supply mints, empty executor ATA and no Order/UserNonce", async () => {
      const infos = await accounts(); assert.ok(infos[2] && infos[3] && infos[4]);
      await checkMint(cashMint.publicKey, infos[2], initializer.publicKey);
      await checkMint(yesMint.publicKey, infos[3], yesAuthority); await checkAta(infos[4]);
      assert.deepEqual(manifest.mints, { cash: cashMint.publicKey.toBase58(), yes: yesMint.publicKey.toBase58(), decimals: 6,
        cashAuthority: initializer.publicKey.toBase58(), yesAuthority: yesAuthority.toBase58(), freezeAuthority: null });
      const owned = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: latestSlot });
      assert.deepEqual(owned.map((account) => account.pubkey.toBase58()).sort(), [config.toBase58(), accounting.toBase58()].sort());
      for (const name of ["Order", "UserNonce"]) {
        assert.equal(owned.filter((account) => account.account.data.subarray(0, 8).equals(discriminator(name))).length, 0);
      }
      preserved = await snapshot();
      evidence.observed.tokenReadbacks = { cash: { ...publicAccount(cashMint.publicKey, infos[2]), supply: "0", decimals: 6,
        authority: initializer.publicKey.toBase58(), freezeAuthority: null },
      yes: { ...publicAccount(yesMint.publicKey, infos[3]), supply: "0", decimals: 6, authority: yesAuthority.toBase58(), freezeAuthority: null },
      executorCashAta: { ...publicAccount(executorCashAta, infos[4]), balance: "0", owner: executor.publicKey.toBase58(), mint: cashMint.publicKey.toBase58() } };
      evidence.observed.protocolAccounts = { addresses: owned.map((item) => item.pubkey.toBase58()), orderCount: 0, userNonceCount: 0 };
    });
    await check("official CLI removes upgrade authority with finalized loader success and unchanged SBF/protocol state", async () => {
      const beforeSignatures = new Set((await connection.getSignaturesForAddress(programData, { limit: 100 }, "finalized")).map((item) => item.signature));
      const balanceBefore = await feePayerLamports();
      const result = await promisify(execFile)("solana", ["--config", join(runtime, "solana.yml"), "--url", connection.rpcEndpoint,
        "--keypair", authorityPath, "--commitment", "finalized", "--output", "json",
        "program", "set-upgrade-authority", programId.toBase58(), "--upgrade-authority", authorityPath, "--final"], { timeout: 60_000 });
      writeFileSync(join(runtime, "remove-authority.log"), result.stdout + result.stderr);
      const added = (await connection.getSignaturesForAddress(programData, { limit: 100 }, "finalized")).filter((item) => !beforeSignatures.has(item.signature));
      assert.equal(added.length, 1, "Exactly one actual loader transaction removes authority");
      const receipt = await finalized(added[0].signature, true);
      const keys = receipt.transaction.message.getAccountKeys();
      const loaderIx = receipt.transaction.message.compiledInstructions.find((ix) => keys.get(ix.programIdIndex)?.equals(loader));
      assert.ok(loaderIx, "Authority removal must invoke the real upgradeable loader");
      assert.deepEqual(Buffer.from(loaderIx.data), Buffer.from([4, 0, 0, 0]), "Actual loader SetAuthority opcode");
      assert.equal(loaderIx.accountKeyIndexes.length, 2, "SetAuthority(None) has no new authority account");
      assert.ok(keys.get(loaderIx.accountKeyIndexes[0])?.equals(programData));
      assert.ok(keys.get(loaderIx.accountKeyIndexes[1])?.equals(initializer.publicKey));
      const data = await connection.getAccountInfo(programData, { commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(data); assert.ok(data.owner.equals(loader)); assert.equal(data.executable, false);
      assert.equal(data.data.readUInt32LE(0), 3); assert.equal(data.data[12], 0);
      assert.equal(data.lamports, dataBefore.lamports); assert.equal(data.data.length, dataBefore.data.length);
      assert.deepEqual(data.data.subarray(45), dataBefore.data.subarray(45), "SBF image unchanged");
      assert.deepEqual(await connection.getAccountInfo(programId, "finalized"), programBefore);
      assert.deepEqual(await snapshot(), preserved);
      const balanceAfter = await feePayerLamports();
      assert.equal(balanceBefore - balanceAfter, BigInt(receipt.meta!.fee), "Only fee payer loses authority-removal fees");
      evidence.observed.authorityRemoval = { signature: added[0].signature, finalizedSlot: receipt.slot, error: null,
        upgradeAuthority: null, loadedImageSha256: createHash("sha256").update(data.data.subarray(45)).digest("hex"),
        protocolStateUnchanged: true, feeLamports: receipt.meta!.fee, feePayerBefore: balanceBefore.toString(), feePayerAfter: balanceAfter.toString() };
    });
    await check("real repeated initialize is finalized rejected and leaves protocol state unchanged", async () => {
      const balanceBefore = await feePayerLamports();
      const instruction = await program.methods.initialize(buildInitializeArgs(evm, programId, operator.publicKey, executor.publicKey)).accountsStrict({
        initializer: initializer.publicKey, program: programId, programData, config, accounting,
        cashMint: cashMint.publicKey, yesMint: yesMint.publicKey, executorCashAta,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
      const block = await connection.getLatestBlockhash("finalized");
      const transaction = new Transaction({ ...block, feePayer: initializer.publicKey }).add(instruction);
      transaction.sign(initializer);
      const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
      const receipt = await finalized(signature, false);
      assert.ok(receipt.meta!.logMessages?.includes(`Program ${programId} invoke [1]`));
      assert.equal((receipt.meta!.err as { InstructionError: [number, unknown] }).InstructionError[0], 0);
      assert.deepEqual(await snapshot(), preserved);
      const balanceAfter = await feePayerLamports();
      assert.equal(balanceBefore - balanceAfter, BigInt(receipt.meta!.fee));
      evidence.observed.initializeReplay = { signature, finalizedSlot: receipt.slot, error: receipt.meta!.err,
        logs: receipt.meta!.logMessages, protocolStateUnchanged: true, feeLamports: receipt.meta!.fee,
        feePayerBefore: balanceBefore.toString(), feePayerAfter: balanceAfter.toString() };
    });
    await check("repeated reusable setup fails before sending, paying fees or changing state", async () => {
      const beforeSent = sent.length;
      const balanceBefore = await feePayerLamports();
      const beforeSignatures = await connection.getSignaturesForAddress(initializer.publicKey, { limit: 100 }, "finalized");
      await assert.rejects(initializeSolanaFixture(input), /Existing Config or Accounting/);
      assert.equal(sent.length, beforeSent);
      assert.equal(await feePayerLamports(), balanceBefore);
      assert.deepEqual(await connection.getSignaturesForAddress(initializer.publicKey, { limit: 100 }, "finalized"), beforeSignatures);
      assert.deepEqual(await snapshot(), preserved);
      evidence.observed.moduleReplay = { transactionsSent: 0, protocolStateUnchanged: true, feePayerUnchanged: true };
      evidence.observed.finalAccounts = await snapshot();
    });
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    connection.sendRawTransaction = originalSend;
    persist();
  }
});
