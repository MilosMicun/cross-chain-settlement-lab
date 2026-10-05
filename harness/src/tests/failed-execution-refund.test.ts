import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { EvmTerms, FinalizedCancellationRequest, FinalizedPendingOrder } from "../source-order.ts";
import type { TerminalObservationRpc, TerminalReadMethod, TerminalObservationResult } from "../terminal-observation.ts";
const { readFinalizedPendingOrder, readFinalizedCancellationRequest } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { observeTerminalOutcome, TerminalObservationError } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { forwardCancellationRequest } = await import(new URL("../cancellation-forwarding.ts", import.meta.url).href) as typeof import("../cancellation-forwarding.ts");
const { buildAcceptCancelledInstruction } = await import(new URL("../cancelled-delivery.ts", import.meta.url).href) as typeof import("../cancelled-delivery.ts");
const { AnchorProvider, BN, BorshInstructionCoder, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-failed-execution-refund.sh after empty setup on the same owned nodes");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest();
const uint = (value: bigint, width: number, little = false) => {
  assert.ok(value >= 0n && value < (1n << BigInt(width * 8)), "Checked unsigned integer width");
  const b = Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex"); return little ? b.reverse() : b;
};
const disc = (value: string) => sha(Buffer.from(value)).subarray(0, 8);
// BN decoders may retain different internal word allocations for equal integers.
function decodedValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(decodedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodedValue(v)]));
  return value;
}
function equalDecoded(actual: unknown, expected: unknown) { assert.deepEqual(decodedValue(actual), decodedValue(expected)); }
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
function credential(name: string) {
  const path = join(runtime, "credentials", `${name}.json`); assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  assert.ok(info); assert.ok(Number.isSafeInteger(info.lamports) && info.lamports >= 0);
  return { address: key.toBase58(), owner: info.owner.toBase58(), executable: info.executable,
    lamports: BigInt(info.lamports), space: info.data.length, dataHex: info.data.toString("hex") };
}

test("mined venue failure stays locked until explicit cancellation and confirmed refund", { timeout: 550_000 }, async (t) => {
  let constructing = false, constructionActivity = 0, forwardingCancellation = false;
  const forwardingCalls: { chain: string; method: string; params?: unknown }[] = [];
  const evmCalls: { method: string; params: unknown }[] = [];
  const rejectConstruction = (method: string) => {
    if (constructing) { constructionActivity++; assert.fail(`Pure builder attempted ${method}`); }
  };
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    rejectConstruction(`EVM RPC ${method}`);
    evmCalls.push({ method, params: structuredClone(params) });
    if (forwardingCancellation) forwardingCalls.push({ chain: "EVM", method });
    return send(method, params);
  };
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      rejectConstruction("source RPC transport");
      if (forwardingCancellation) {
        const call = JSON.parse(String(init?.body));
        forwardingCalls.push({ chain: "Solana", method: call.method, params: call.params });
        assert.equal(call.method, "getMultipleAccounts"); assert.equal(call.params[1].commitment, "finalized");
        assert.equal(call.params[1].minContextSlot, cancellationSlot);
      }
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  const guardedConnectionMethods = [...new Set([...Object.getOwnPropertyNames(Connection.prototype), ...Object.keys(connection)])]
    .filter((name) => /^(get|send|request|confirm|simulate|_rpc)/.test(name) && typeof Reflect.get(connection, name) === "function");
  for (const name of guardedConnectionMethods) {
    const original = Reflect.get(connection, name) as (...args: unknown[]) => unknown;
    Object.defineProperty(connection, name, { configurable: true, value: (...args: unknown[]) => {
      rejectConstruction(`connection.${name}`); return original.apply(connection, args);
    } });
  }
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const setup = json("agreement-evidence.json");
  const initializer = credential("initializer"), operator = credential("operator");
  assert.equal(initializer.publicKey.toBase58(), source.roles.initializer);
  assert.equal(operator.publicKey.toBase58(), source.roles.operator);
  const originalUser = Keypair.generate(), user = originalUser.publicKey;
  const nonce = 0n, cashAmount = 10_000_000n, minimumShares = 20_000_001n;
  const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
  const wallet = new Wallet(operator);
  const forbidden = async () => { constructionActivity++; assert.fail("Builder must not sign, simulate or submit"); };
  wallet.signTransaction = forbidden; wallet.signAllTransactions = forbidden;
  const anchorProvider = new AnchorProvider(connection, wallet, { commitment: "finalized" });
  anchorProvider.sendAndConfirm = forbidden; anchorProvider.sendAll = forbidden; anchorProvider.simulate = forbidden;
  const program = new Program<SettlementLab>(idl, anchorProvider), programId = program.programId;
  assert.equal(programId.toBase58(), source.programId);
  const parser = new EventParser(programId, program.coder);
  const config = new PublicKey(source.accounts.config), cashMint = new PublicKey(source.mints.cash), yesMint = new PublicKey(source.mints.yes);
  const [canonicalConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId); assert.ok(config.equals(canonicalConfig));
  const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
  assert.equal(accounting.toBase58(), source.accounts.accounting); assert.equal(accountingBump, source.bumps.accounting);
  const [userNonce, userBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], programId);
  const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  const userCashAta = getAssociatedTokenAddressSync(cashMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userYesAta = getAssociatedTokenAddressSync(yesMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const keys = { config, accounting, userNonce, order, cashMint, yesMint,
    executorCashAta: new PublicKey(source.accounts.executorCashAta), userCashAta, userYesAta, escrow, user };
  assert.ok(getAssociatedTokenAddressSync(cashMint, new PublicKey(source.roles.executor), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).equals(keys.executorCashAta));
  // Independent fixed-width SPEC encoding from deployment values and selected terms.
  // No reader output or stored hash is an input to these expectations.
  const domain = Buffer.concat([raw(evm.sourceDomain), raw(evm.destinationDomain), programId.toBuffer(), uint(BigInt(evm.chainId), 32), raw(evm.contracts.settlement)]);
  const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]), id = sha(identityPreimage);
  const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, id, user.toBuffer(), uint(nonce, 8), raw(evm.market),
    Buffer.from([0]), uint(cashAmount, 8), uint(minimumShares, 8)]), hash = sha(termsPreimage);
  const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), hash, Buffer.from([2]), uint(0n, 8)]), receipt = sha(receiptPreimage);
  assert.deepEqual([domain.length, identityPreimage.length, termsPreimage.length, receiptPreimage.length], [148, 196, 277, 49]);
  const independent = { id, hash, receipt };
  const expectedTerms = { identity: { domain: { sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
    solanaProgram: hex(programId.toBuffer()), chainId: BigInt(evm.chainId), settlement: evm.contracts.settlement.toLowerCase() },
    user: hex(user.toBuffer()), nonce }, market: evm.market, outcome: 0, cashAmount, minimumShares } as EvmTerms;
  const evidence: { scope: string; checks: string[]; stages: Record<string, unknown>; limitations: string[]; failure?: string } = {
    scope: "A reverted venue purchase leaves funds locked; only user intent plus confirmed terminal destination cancellation enables refund.",
    checks: [], stages: { selectedInputs: { deployment: { evm, source }, user: user.toBase58(), nonce, cashAmount, minimumShares,
      accounts: Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, key.toBase58()])) },
      independentHashes: { domainPreimage: hex(domain), identityPreimage: hex(identityPreimage), termsPreimage: hex(termsPreimage), receiptPreimage: hex(receiptPreimage),
        orderId: hex(id), termsHash: hex(hash), receiptHash: hex(receipt) } },
    limitations: ["Deterministic mock venue; source SPL cash and EVM ERC20 cash are separate tokens, with executor-owned EVM liquidity.",
      "Explicitly trusted operator/RPC; source operator signature attests evidence, not a cryptographic bridge proof.",
      "Finalized Solana and local canonical EVM receipt/storage plus N+2 only; no production bridge/finality.",
      "Existing Agave 4.1.2 SIMD-0500 genesis exception; see unchanged setup/runner evidence.",
      "Forced-gas execute is an explicit TEST FIXTURE action, not forwardPendingOrder or its normal failing-estimation path.",
      "One explicit refund replay; no automatic retries, resubmission or restart recovery.",
      "Unseen and a reverted attempt cannot block a future successful execute; they are not terminal cancellation."],
  };
  const persist = () => writeFileSync(join(runtime, "failed-execution-refund-evidence.json"),
    JSON.stringify(decodedValue(evidence), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  let latestSlot = setup.observed.agreement.solana.contextSlot;
  async function snapshot() {
    const entries = Object.entries(keys);
    const response = await connection.getMultipleAccountsInfoAndContext(entries.map(([, key]) => key), {
      commitment: "finalized", minContextSlot: latestSlot });
    assert.ok(response.context.slot >= latestSlot);
    const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
    assert.ok(protocol.context.slot >= response.context.slot);
    const payer = await connection.getAccountInfoAndContext(operator.publicKey, { commitment: "finalized", minContextSlot: response.context.slot });
    assert.ok(payer.context.slot >= response.context.slot);
    const tokenAccounts = [];
    for (const mint of [keys.cashMint, keys.yesMint]) {
      const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { commitment: "finalized", minContextSlot: response.context.slot,
        filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] });
      tokenAccounts.push(...accounts.map((a) => publicAccount(a.pubkey, a.account)));
    }
    const signatures = (await connection.getSignaturesForAddress(programId, { limit: 100 }, "finalized"))
      .map(({ signature, slot, err, confirmationStatus }) => ({ signature, slot, err, confirmationStatus }));
    return { contextSlot: response.context.slot, minContextSlot: latestSlot, protocolContextSlot: protocol.context.slot,
      records: Object.fromEntries(entries.map(([name, key], i) => [name, publicAccount(key, response.value[i])])),
      protocolAccounts: protocol.value.map((item) => publicAccount(item.pubkey, item.account)).sort((a, b) => a.address.localeCompare(b.address)),
      tokenAccounts: tokenAccounts.sort((a, b) => a.address.localeCompare(b.address)), signatures,
      feePayer: payer.value && publicAccount(operator.publicKey, payer.value) };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  function history(before: Snapshot, after: Snapshot, tx: Awaited<ReturnType<typeof submit>>) {
    assert.deepEqual(after.signatures, [{ signature: tx.signature, slot: tx.finalizedSlot, err: null, confirmationStatus: "finalized" }, ...before.signatures]);
  }
  function unchangedSource(before: Snapshot, after: Snapshot) {
    for (const name of ["records", "protocolAccounts", "tokenAccounts", "feePayer", "signatures"] as const) assert.deepEqual(after[name], before[name]);
  }
  function economics(s: Snapshot) {
    const data = (name: string) => Buffer.from(s.records[name].dataHex, "hex");
    const amount = (name: string) => data(name).readBigUInt64LE(64);
    const supply = (name: string) => data(name).readBigUInt64LE(36);
    const counters = Array.from({ length: 4 }, (_, i) => data("accounting").readBigUInt64LE(40 + i * 16)
      + (data("accounting").readBigUInt64LE(48 + i * 16) << 64n));
    return { userCash: amount("userCashAta"), escrow: amount("escrow"), executorCash: amount("executorCashAta"),
      cashSupply: supply("cashMint"), userYes: amount("userYesAta"), yesSupply: supply("yesMint"), counters };
  }
  const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
  const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider);
  const yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
  async function evmSnapshot() {
    const blockTag = toQuantity(BigInt(await provider.send("eth_blockNumber", [])));
    const read = (c: Contract, name: string, ...args: unknown[]) => c.getFunction(name).staticCall(...args, { blockTag });
    const balances: Record<string, { supply: bigint; holders: Record<string, bigint> }> = {};
    for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
      const holders: Record<string, bigint> = {};
      for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
        holders[role] = await read(token, "balanceOf", address);
      }
      const supply: bigint = await read(token, "totalSupply");
      assert.equal(Object.values(holders).reduce((a, b) => a + b, 0n), supply);
      balances[label] = { supply, holders };
    }
    const record = await read(settlement, "orderRecord", hex(independent.id));
    const native: Record<string, { balance: bigint; nonce: bigint }> = {};
    for (const [role, address] of Object.entries({ ...evm.roles, ...evm.contracts })) {
      native[role] = { balance: BigInt(await provider.send("eth_getBalance", [address, blockTag])),
        nonce: BigInt(await provider.send("eth_getTransactionCount", [address, blockTag])) };
    }
    const events = await provider.send("eth_getLogs", [{ fromBlock: "0x0", toBlock: blockTag, address: Object.values(evm.contracts) }]);
    const allowances: Record<string, bigint> = {};
    const addresses = { ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement };
    for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
      for (const [ownerRole, owner] of Object.entries(addresses)) {
        for (const [spenderRole, spender] of Object.entries(addresses)) {
          allowances[`${label}:${ownerRole}:${spenderRole}`] = await read(token, "allowance", owner, spender);
        }
      }
    }
    const state = { balances, allowances, recordAbi: settlement.interface.encodeFunctionResult("orderRecord", [record]),
      executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement),
      venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue),
      totalCashSpent: await read(settlement, "totalCashSpent"), totalSharesPurchased: await read(settlement, "totalSharesPurchased"),
      native, events };
    return { blockTag, blockHash: (await provider.send("eth_getBlockByNumber", [blockTag, false])).hash, state };
  }
  async function submit(instruction: TransactionInstruction | TransactionInstruction[], payer: Keypair) {
    const block = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ ...block, feePayer: payer.publicKey }).add(...(Array.isArray(instruction) ? instruction : [instruction])); tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "finalized", maxRetries: 0 });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === "finalized") {
        assert.equal(status.err, null);
        const txRecord = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(txRecord?.meta); assert.equal(txRecord.meta.err, null); assert.equal(txRecord.slot, status.slot);
        latestSlot = Math.max(latestSlot, txRecord.slot);
        const message = txRecord.transaction.message;
        assert.ok(Number.isSafeInteger(txRecord.meta.fee));
        const payerBalances = payer.publicKey.toBase58() === source.roles.initializer ? null : (() => {
          assert.ok(Number.isSafeInteger(txRecord.meta!.preBalances[0]) && Number.isSafeInteger(txRecord.meta!.postBalances[0]));
          const before = BigInt(txRecord.meta!.preBalances[0]), after = BigInt(txRecord.meta!.postBalances[0]);
          return { before, after };
        })();
        const submitted = Array.isArray(instruction) ? instruction : [instruction];
        assert.deepEqual(message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()), [payer.publicKey.toBase58()]);
        assert.deepEqual(message.compiledInstructions.map((ix) => ({ program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
          accounts: ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), dataHex: Buffer.from(ix.data).toString("hex") })),
          submitted.map((ix) => ({ program: ix.programId.toBase58(), accounts: ix.keys.map((meta) => meta.pubkey.toBase58()), dataHex: ix.data.toString("hex") })));
        const inner = (txRecord.meta.innerInstructions ?? []).flatMap((group) => group.instructions.map((ix) => ({
          parentIndex: group.index, program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
          accounts: ix.accounts.map((index) => message.staticAccountKeys[index].toBase58()),
          dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex") })));
        return { signature, finalizedSlot: txRecord.slot, confirmationStatus: status.confirmationStatus,
          events: [...parser.parseLogs(txRecord.meta.logMessages ?? [])], inner, fee: BigInt(txRecord.meta.fee),
          requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()),
          payerBalances,
          logs: txRecord.meta.logMessages, transaction: { message: message.serialize().toString("base64"),
            instructions: message.compiledInstructions.map((ix) => ({ program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
              accounts: ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), dataHex: Buffer.from(ix.data).toString("hex") })),
            preTokenBalances: txRecord.meta.preTokenBalances, postTokenBalances: txRecord.meta.postTokenBalances } };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Finalization deadline exceeded; no automatic resubmission: ${signature}`);
  }
  let live: LiveConfigurationObservation, pending: FinalizedPendingOrder, cancellationRequest: FinalizedCancellationRequest;
  let creationSlot = 0, cancellationSlot = 0, failedHash = "", cancelHash = "";
  let locked: Snapshot, before: Snapshot, after: Snapshot;
  let destination: Awaited<ReturnType<typeof evmSnapshot>>, instruction: TransactionInstruction;
  let confirmed: Extract<TerminalObservationResult, { kind: "Confirmed" }>;
  const lockedEconomics = { userCash: 15_000_000n, escrow: 10_000_000n, executorCash: 0n, cashSupply: 25_000_000n,
    userYes: 0n, yesSupply: 0n, counters: [10_000_000n, 0n, 0n, 0n] };
  const refundedEconomics = { ...lockedEconomics, userCash: 25_000_000n, escrow: 0n, counters: [10_000_000n, 10_000_000n, 0n, 0n] };
  const expectedOrder = (state: 0 | 1 | 3) => Buffer.concat([disc("account:Order"), config.toBuffer(), user.toBuffer(), uint(nonce, 8, true), raw(evm.market),
    Buffer.from([0]), uint(cashAmount, 8, true), uint(minimumShares, 8, true), independent.id, independent.hash,
    userCashAta.toBuffer(), userYesAta.toBuffer(), escrow.toBuffer(), state === 3
      ? Buffer.concat([Buffer.from([3, 1, 1, 2]), uint(0n, 8, true), independent.receipt, Buffer.from([orderBump, escrowBump])])
      : Buffer.concat([Buffer.from([state, state, 0, orderBump, escrowBump]), Buffer.alloc(41)])]);
  const expectedAccounting = (refunded: bigint) => Buffer.concat([disc("account:Accounting"), config.toBuffer(),
    ...[cashAmount, refunded, 0n, 0n].map((n) => uint(n, 16, true)), Buffer.from([accountingBump])]);
  async function reverify() {
    live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: latestSlot });
    assert.equal(live.solana.config.dataHex, setup.observed.agreement.solana.config.dataHex);
    assert.deepEqual(live.evm.configuration, setup.observed.agreement.evm.configuration);
    assert.deepEqual(live.solana.configuration, live.evm.configuration);
  }
  async function observe(label: string, transactionHash: string, failed = false) {
    const calls: { method: TerminalReadMethod; params: unknown[]; response?: unknown }[] = [];
    const rpc: TerminalObservationRpc = { async send(method, params) {
      rejectConstruction(`observer RPC ${method}`);
      assert.ok(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"].includes(method));
      const call: typeof calls[number] = { method, params: structuredClone(params) }; calls.push(call);
      const response = await provider.send(method, params); call.response = structuredClone(response); return response;
    } };
    const sourceBefore = await snapshot(), evmBefore = await evmSnapshot();
    const input = { provider: rpc, expectedConfiguration: live, orderId: pending.orderId,
      termsHash: pending.termsHash, terms: pending.terms, transactionHash };
    let result: TerminalObservationResult | undefined;
    if (failed) {
      await assert.rejects(observeTerminalOutcome(input), (error: unknown) => error instanceof TerminalObservationError && error.code === "FailedTransaction");
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt"]);
    } else result = await observeTerminalOutcome(input);
    const sourceAfter = await snapshot(), evmAfter = await evmSnapshot();
    unchangedSource(sourceBefore, sourceAfter); assert.deepEqual(evmAfter, evmBefore);
    evidence.stages[label] = { transactionHash, result: failed ? { error: "TerminalObservationError", code: "FailedTransaction", terminalReceipt: null } : result,
      calls, sourceBefore, sourceAfter, evmBefore, evmAfter, mining: 0, signing: 0, submissions: 0 };
    persist(); return result;
  }
  async function build(observation: TerminalObservationResult) {
    constructing = true;
    try { return await buildAcceptCancelledInstruction({ program, expectedConfiguration: live, sourceRequest: cancellationRequest, observation }); }
    finally { constructing = false; }
  }
  try {
    await check("unchanged live setup has only Config/Accounting, zero source supply and complete Unseen destination", async () => {
      assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0); assert.ok(setup.observed.agreement);
      await reverify();
      const accounts = await connection.getMultipleAccountsInfoAndContext(Object.values(keys), { commitment: "finalized", minContextSlot: latestSlot });
      for (const name of ["userNonce", "order", "escrow", "userCashAta", "userYesAta", "user"] as const)
        assert.equal(accounts.value[Object.keys(keys).indexOf(name)], null);
      const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: latestSlot }); assert.equal(protocol.length, 2);
      for (const mint of [cashMint, yesMint]) {
        const info = await connection.getAccountInfo(mint, { commitment: "finalized", minContextSlot: latestSlot }); assert.ok(info);
        const decoded = unpackMint(mint, info, TOKEN_PROGRAM_ID); assert.equal(decoded.supply, 0n); assert.equal(decoded.decimals, 6); assert.equal(decoded.freezeAuthority, null);
      }
      const evmBefore = await evmSnapshot(); assert.equal(BigInt(evmBefore.blockTag), 9n);
      assert.match(evmBefore.state.recordAbi, /^0x0+$/, "Every field of Unseen record is zero");
      assert.deepEqual(evmBefore.state.balances, { usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 100_000_000n, venue: 0n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 200_000_000n, settlement: 0n } } });
      assert.equal(evmBefore.state.executorAllowance, 100_000_000n); assert.equal(evmBefore.state.venueAllowance, 0n);
      assert.equal(evmBefore.state.totalCashSpent, 0n); assert.equal(evmBefore.state.totalSharesPurchased, 0n);
      assert.equal(evmBefore.state.events.filter((e: { address: string }) => e.address === evm.contracts.settlement.toLowerCase()).length, 0);
      evidence.stages.emptySetup = { live, sourceAccounts: accounts.value.map((info, i) => info && publicAccount(Object.values(keys)[i], info)),
        protocolAccounts: protocol.map((a) => publicAccount(a.pubkey, a.account)), evm: evmBefore };
    });
    await check("distinct original user receives small SOL and canonical legacy ATAs with cash only", async () => {
      assert.ok(!Object.values(source.roles).includes(user.toBase58()));
      const path = join(runtime, "credentials", "failed-execution-user.json");
      writeFileSync(path, JSON.stringify(Array.from(originalUser.secretKey)) + "\n", { mode: 0o600, flag: "wx" });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const fixture = await submit([
        SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: user, lamports: 20_000_000 }),
        createAssociatedTokenAccountInstruction(initializer.publicKey, userCashAta, user, cashMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(initializer.publicKey, userYesAta, user, yesMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(cashMint, userCashAta, initializer.publicKey, 25_000_000n, [], TOKEN_PROGRAM_ID),
      ], initializer);
      const fixtureKeys = [config, accounting, cashMint, yesMint, keys.executorCashAta, userCashAta, userYesAta, user];
      const accounts = await connection.getMultipleAccountsInfoAndContext(fixtureKeys, { commitment: "finalized", minContextSlot: latestSlot });
      for (const [i, key, owner, amount] of [[4, keys.executorCashAta, new PublicKey(source.roles.executor), 0n], [5, userCashAta, user, 25_000_000n], [6, userYesAta, user, 0n]] as const) {
        assert.ok(accounts.value[i]); const token = unpackAccount(key, accounts.value[i], TOKEN_PROGRAM_ID);
        assert.ok(token.owner.equals(owner)); assert.equal(token.amount, amount); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
        assert.ok(token.mint.equals(i === 6 ? yesMint : cashMint)); assert.equal(token.isInitialized, true); assert.equal(token.isFrozen, false);
      }
      assert.equal(unpackMint(cashMint, accounts.value[2]!, TOKEN_PROGRAM_ID).supply, 25_000_000n);
      assert.equal(unpackMint(yesMint, accounts.value[3]!, TOKEN_PROGRAM_ID).supply, 0n);
      assert.equal(accounts.value[7]!.lamports, 20_000_000);
      assert.equal(accounts.value[1]!.data.subarray(40, 104).toString("hex"), Buffer.alloc(64).toString("hex"));
      evidence.stages.fixture = { ...fixture, contextSlot: accounts.context.slot,
        accounts: fixtureKeys.map((key, i) => publicAccount(key, accounts.value[i])), sourceYesMinted: 0, executorCash: 0 };
    });
    await check("real original-user create_order finalizes full canonical bytes with unattainable positive minimum", async () => {
      const create = await program.methods.createOrder({ nonce: new BN("0"), cashAmount: new BN(cashAmount.toString()), minimumShares: new BN(minimumShares.toString()) })
        .accountsStrict({ user, config, accounting, userNonce, order, cashMint, yesMint, userCashAta, userYesAta, escrow,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
      const creation = await submit(create, originalUser); creationSlot = creation.finalizedSlot;
      equalDecoded(creation.events, [{ name: "orderCreated", data: { config, user, nonce: new BN("0"), order,
        orderId: [...id], termsHash: [...hash], market: [...raw(evm.market)], outcome: 0, cashAmount: new BN(cashAmount.toString()),
        minimumShares: new BN(minimumShares.toString()), userCashAta, userYesAta, escrow } }]);
      locked = await snapshot(); assert.deepEqual(economics(locked), lockedEconomics);
      assert.equal(locked.records.order.dataHex, expectedOrder(0).toString("hex")); assert.equal(locked.records.order.space, 335);
      assert.equal(locked.records.order.owner, programId.toBase58()); assert.equal(locked.records.order.executable, false);
      assert.equal(locked.records.userNonce.dataHex, Buffer.concat([disc("account:UserNonce"), config.toBuffer(), user.toBuffer(), uint(1n, 8, true), Buffer.from([userBump])]).toString("hex"));
      assert.equal(locked.records.userNonce.owner, programId.toBase58());
      assert.equal(locked.records.accounting.dataHex, expectedAccounting(0n).toString("hex")); assert.equal(locked.records.accounting.space, 105);
      assert.equal(locked.records.config.dataHex, live.solana.config.dataHex); assert.equal(locked.protocolAccounts.length, 4);
      const fixture = evidence.stages.fixture as { accounts: ReturnType<typeof publicAccount>[] };
      for (const key of ["config", "cashMint", "yesMint", "executorCashAta", "userYesAta"] as const)
        assert.deepEqual(locked.records[key], fixture.accounts.find((a) => a.address === keys[key].toBase58()));
      const userCashBefore = structuredClone(fixture.accounts.find((a) => a.address === userCashAta.toBase58())!);
      const cashBytes = Buffer.from(userCashBefore.dataHex, "hex"); cashBytes.writeBigUInt64LE(15_000_000n, 64); userCashBefore.dataHex = cashBytes.toString("hex");
      assert.deepEqual(locked.records.userCashAta, userCashBefore);
      assert.ok(creation.payerBalances); assert.equal(creation.payerBalances.before, 20_000_000n);
      assert.equal(creation.payerBalances.after, creation.payerBalances.before - creation.fee - locked.records.userNonce.lamports - locked.records.order.lamports - locked.records.escrow.lamports);
      const escrowInfo = await connection.getAccountInfo(escrow, { commitment: "finalized", minContextSlot: creationSlot }); assert.ok(escrowInfo);
      const token = unpackAccount(escrow, escrowInfo, TOKEN_PROGRAM_ID);
      assert.ok(token.owner.equals(order) && token.mint.equals(cashMint)); assert.equal(token.amount, cashAmount);
      assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null); assert.equal(token.isInitialized, true); assert.equal(token.isFrozen, false); assert.equal(token.isNative, false);
      const decoded = program.coder.accounts.decode("order", expectedOrder(0));
      assert.deepEqual(decoded.state, { pending: {} }); assert.equal(decoded.cancellationRequested, false); assert.equal(decoded.acceptedReceipt, null);
      pending = await readFinalizedPendingOrder({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: creationSlot });
      assert.ok(pending.contextSlot >= creationSlot); assert.equal(pending.orderId, hex(id)); assert.equal(pending.termsHash, hex(hash));
      assert.deepEqual(pending.terms, expectedTerms); assert.equal(pending.escrowBalance, cashAmount);
      assert.deepEqual(pending.accounts, Object.fromEntries(["config", "userNonce", "order", "escrow", "userCashAta", "userYesAta"].map((name) => [name, keys[name as keyof typeof keys].toBase58()])));
      evidence.stages.creation = { ...creation, snapshot: locked, economics: economics(locked), reader: pending,
        independentOrderHex: expectedOrder(0).toString("hex"), independentAccountingHex: expectedAccounting(0n).toString("hex") };
    });
    await check("one forced-gas execute really mines status 0 with exact MockVenue MinimumNotMet and full economic rollback", async () => {
      await reverify();
      assert.equal(BigInt(await provider.send("eth_chainId", [])), expectedTerms.identity.domain.chainId);
      const evmOperator = await provider.getSigner(evm.roles.operator); assert.equal((await evmOperator.getAddress()).toLowerCase(), live.evm.configuration.evmOperator);
      assert.equal((await settlement.getFunction("operator").staticCall()).toLowerCase(), evm.roles.operator.toLowerCase());
      const actualDomain = await settlement.getFunction("domain").staticCall(), d = expectedTerms.identity.domain;
      assert.deepEqual([...actualDomain].map((v) => typeof v === "string" ? v.toLowerCase() : v), [d.sourceDomain, d.destinationDomain, d.solanaProgram, d.chainId, d.settlement]);
      const beforeExecute = await evmSnapshot(); assert.match(beforeExecute.state.recordAbi, /^0x0+$/);
      const callsStart = evmCalls.length;
      // Deliberate fixture bypass of estimateGas, never adapter retry behavior.
      const gasLimit = 1_000_000n;
      const tx = await settlement.connect(evmOperator).getFunction("execute").send(pending.orderId, pending.terms, { gasLimit }); failedHash = tx.hash;
      assert.match(failedHash, /^0x[0-9a-f]{64}$/);
      const receipt = await provider.waitForTransaction(failedHash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, 0);
      const transaction = await provider.send("eth_getTransactionByHash", [failedHash]);
      const rawReceipt = await provider.send("eth_getTransactionReceipt", [failedHash]); assert.equal(rawReceipt.status, "0x0");
      assert.equal(transaction.from, evm.roles.operator.toLowerCase()); assert.equal(transaction.to, evm.contracts.settlement.toLowerCase());
      assert.equal(transaction.value, "0x0"); assert.equal(BigInt(transaction.chainId), 31337n); assert.equal(BigInt(transaction.gas), gasLimit);
      assert.equal(transaction.input, settlement.interface.encodeFunctionData("execute", [pending.orderId, expectedTerms]));
      assert.equal(BigInt(transaction.nonce), beforeExecute.state.native.operator.nonce); assert.deepEqual(receipt.logs, []); assert.deepEqual(rawReceipt.logs, []);
      const trace = await provider.send("debug_traceTransaction", [failedHash, { disableStorage: true, disableMemory: true, disableStack: true }]);
      const venue = new Contract(evm.contracts.venue, compiled("MockVenue"), provider);
      const expectedRevert = venue.interface.encodeErrorResult("MinimumNotMet", [20_000_000n, minimumShares]);
      const actualRevert = `0x${String(trace.returnValue).replace(/^0x/, "")}`; assert.equal(trace.failed, true); assert.equal(actualRevert, expectedRevert);
      const decodedError = venue.interface.parseError(actualRevert); assert.ok(decodedError); assert.equal(decodedError.name, "MinimumNotMet");
      assert.deepEqual([...decodedError.args], [20_000_000n, 20_000_001n]);
      const gasCost = receipt.gasUsed * receipt.gasPrice; assert.ok(receipt.gasUsed < gasLimit && gasCost > 0n);
      const expected = structuredClone(beforeExecute.state); expected.native.operator.balance -= gasCost; expected.native.operator.nonce++;
      destination = await evmSnapshot(); assert.deepEqual(destination.state, expected, "TransferFrom, approval and all economics revert atomically");
      assert.match(destination.state.recordAbi, /^0x0+$/); assert.equal(BigInt(destination.blockTag), BigInt(beforeExecute.blockTag) + 1n);
      assert.equal(BigInt(destination.blockTag), BigInt(rawReceipt.blockNumber)); assert.equal(destination.blockHash, rawReceipt.blockHash);
      const calls = evmCalls.slice(callsStart);
      assert.equal(calls.filter((c) => c.method === "eth_sendTransaction").length, 1); assert.equal(calls.filter((c) => c.method === "eth_estimateGas").length, 0);
      unchangedSource(locked, await snapshot());
      evidence.stages.failedExecution = { transactionHash: failedHash, receipt: rawReceipt, transaction, forcedGasLimit: gasLimit, gasCost,
        actualRevert, expectedRevert, decodedError: { name: decodedError.name, arguments: [...decodedError.args] },
        trace: { method: "debug_traceTransaction", failed: trace.failed, returnValue: trace.returnValue, opcodeTraceOmitted: true }, before: beforeExecute, after: destination,
        sourceAfter: await snapshot(), sourceEconomics: economics(locked), explicitExecuteSubmissions: 1, gasEstimationCalls: 0 };
    });
    await check("failed hash rejects terminal observation before and after two additional fixture blocks; escrow stays Pending", async () => {
      await observe("failedAtInclusion", failedHash, true); unchangedSource(locked, await snapshot());
      const failedAtN = await evmSnapshot();
      await provider.send("evm_mine", []); await provider.send("evm_mine", []);
      const failedAtNPlus2 = await evmSnapshot(); assert.deepEqual(failedAtNPlus2.state, failedAtN.state);
      assert.equal(BigInt(failedAtNPlus2.blockTag), BigInt(failedAtN.blockTag) + 2n);
      await observe("failedAtNPlus2", failedHash, true); unchangedSource(locked, await snapshot());
      assert.deepEqual(economics(await snapshot()), lockedEconomics); assert.equal(locked.records.order.dataHex, expectedOrder(0).toString("hex"));
      evidence.stages.failureBoundary = { failedAtN, failedAtNPlus2, source: await snapshot(), sourceState: "Pending", cancellationRequested: false,
        acceptedReceipt: null, lockedCash: cashAmount, additionalBlocksMined: 2, refundInstructions: 0, retries: 0,
        boundary: "FailedTransaction, Unseen and elapsed blocks do not authorize refund or permanently prevent future execution." };
    });
    await check("original user explicitly cancels unchanged failed order; only intent, history and user fee change", async () => {
      const beforeCancel = await snapshot(), destinationBefore = await evmSnapshot();
      const cancel = await program.methods.requestCancel(new BN(nonce.toString()), [...independent.hash])
        .accountsStrict({ user, config: keys.config, order: keys.order }).instruction();
      assert.deepEqual(cancel.data, Buffer.concat([disc("global:request_cancel"), uint(nonce, 8, true), independent.hash]));
      assert.ok(cancel.programId.equals(programId));
      assert.deepEqual(cancel.keys, [user, keys.config, keys.order].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i === 2 })));
      const cancellation = await submit(cancel, originalUser); cancellationSlot = cancellation.finalizedSlot;
      assert.ok(cancellationSlot > pending.contextSlot);
      assert.deepEqual(cancellation.requiredSigners, [user.toBase58()]);
      assert.deepEqual(cancellation.transaction.instructions, [{ program: programId.toBase58(), accounts: [user, keys.config, keys.order].map((k) => k.toBase58()),
        dataHex: cancel.data.toString("hex") }]);
      equalDecoded(cancellation.events, [{ name: "cancellationRequested", data: { config: keys.config, user, order: keys.order,
        nonce: new BN(nonce.toString()), orderId: [...independent.id], termsHash: [...independent.hash] } }]);
      assert.deepEqual(cancellation.inner, []);
      assert.deepEqual(cancellation.logs?.filter((log) => /^Program .* invoke/.test(log)), [`Program ${programId.toBase58()} invoke [1]`]);
      locked = await snapshot(); const expected = structuredClone(beforeCancel);
      const orderBytes = Buffer.from(expected.records.order.dataHex, "hex");
      assert.deepEqual([...orderBytes.subarray(289, 292)], [0, 0, 0]); orderBytes[289] = 1; orderBytes[290] = 1;
      expected.records.order.dataHex = orderBytes.toString("hex"); expected.records.user.lamports -= cancellation.fee;
      expected.protocolAccounts.find((a) => a.address === keys.order.toBase58())!.dataHex = orderBytes.toString("hex");
      assert.deepEqual(locked.records, expected.records); assert.deepEqual(locked.protocolAccounts, expected.protocolAccounts);
      assert.deepEqual(locked.tokenAccounts, beforeCancel.tokenAccounts); assert.deepEqual(locked.feePayer, beforeCancel.feePayer);
      history(beforeCancel, locked, cancellation); assert.deepEqual(economics(locked), economics(beforeCancel));
      const decoded = program.coder.accounts.decode("order", orderBytes);
      assert.deepEqual(decoded.state, { cancelRequested: {} }); assert.equal(decoded.cancellationRequested, true); assert.equal(decoded.acceptedReceipt, null);
      cancellationRequest = await readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: cancellationSlot });
      assert.ok(cancellationRequest.contextSlot >= cancellationSlot);
      assert.equal(cancellationRequest.terms.minimumShares, 20_000_001n);
      assert.deepEqual(cancellationRequest, { ...pending, contextSlot: cancellationRequest.contextSlot, state: "CancelRequested", cancellationRequested: true });
      assert.deepEqual(await evmSnapshot(), destinationBefore, "User intent does not mutate destination");
      evidence.stages.sourceCancellation = { ...cancellation, before: beforeCancel, after: locked, request: cancellationRequest,
        instruction: { dataHex: cancel.data.toString("hex"), metas: cancel.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })) },
        economics: economics(locked), destinationBefore, destinationAfter: await evmSnapshot() };
    });
    await check("one forwarded cancellation creates terminal Cancelled without spending or custody changes", async () => {
      const beforeCancel = await evmSnapshot(); assert.match(beforeCancel.state.recordAbi, /^0x0+$/);
      const evmOperator = await provider.getSigner(evm.roles.operator);
      forwardingCancellation = true;
      let forwarded;
      try { forwarded = await forwardCancellationRequest({ provider, operator: evmOperator, connection, expectedConfiguration: live,
        user, nonce, minFinalizedSlot: cancellationSlot }); } finally { forwardingCancellation = false; }
      cancelHash = forwarded.transactionHash; assert.notEqual(cancelHash, failedHash);
      assert.deepEqual(forwarded.sourceRequest, { ...cancellationRequest, contextSlot: forwarded.sourceRequest.contextSlot });
      assert.ok(forwarded.sourceRequest.contextSlot >= cancellationSlot); assert.equal(forwarded.sourceRequest.terms.minimumShares, 20_000_001n);
      assert.equal(forwardingCalls.filter((c) => c.method === "eth_sendTransaction").length, 1);
      assert.equal(forwardingCalls.filter((c) => c.chain === "Solana").length, 1);
      const receipt = await provider.waitForTransaction(cancelHash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, 1);
      const transaction = await provider.send("eth_getTransactionByHash", [cancelHash]), rawReceipt = await provider.send("eth_getTransactionReceipt", [cancelHash]);
      assert.equal(rawReceipt.status, "0x1"); assert.equal(transaction.from, evm.roles.operator.toLowerCase());
      assert.equal(transaction.to, evm.contracts.settlement.toLowerCase()); assert.equal(transaction.value, "0x0"); assert.equal(BigInt(transaction.chainId), 31337n);
      assert.equal(transaction.input, settlement.interface.encodeFunctionData("cancel", [pending.orderId, expectedTerms]));
      assert.equal(BigInt(transaction.nonce), beforeCancel.state.native.operator.nonce);
      assert.equal(receipt.logs.length, 1); assert.equal(receipt.logs[0].address.toLowerCase(), evm.contracts.settlement.toLowerCase());
      const event = settlement.interface.parseLog(receipt.logs[0]); assert.ok(event); assert.equal(event.name, "TerminalRecorded");
      assert.deepEqual([...event.args], [pending.orderId, hex(hash), 2n, 0n, hex(independent.receipt)]);
      const expected = structuredClone(beforeCancel.state);
      const terminalRecord = { terms: expectedTerms, termsHash: hex(hash), status: 2n, filledQuantity: 0n, receiptHash: hex(independent.receipt) };
      expected.recordAbi = settlement.interface.encodeFunctionResult("orderRecord", [terminalRecord]);
      const gasCost = receipt.gasUsed * receipt.gasPrice; expected.native.operator.balance -= gasCost; expected.native.operator.nonce++;
      const included = await evmSnapshot();
      const logs = await provider.send("eth_getLogs", [{ blockHash: rawReceipt.blockHash, address: Object.values(evm.contracts) }]);
      assert.equal(logs.length, 1); expected.events.push(...logs);
      assert.deepEqual(included.state, expected); assert.equal(BigInt(included.blockTag), BigInt(beforeCancel.blockTag) + 1n);
      assert.equal(BigInt(included.blockTag), BigInt(rawReceipt.blockNumber)); assert.equal(included.blockHash, rawReceipt.blockHash);
      unchangedSource(locked, await snapshot());
      evidence.stages.destinationCancellation = { forwarded, transaction, receipt: rawReceipt, gasCost, event: { name: event.name, arguments: [...event.args] },
        before: beforeCancel, included, forwardingCalls, sourceAfter: await snapshot(), termsUnchanged: true };
    });
    await check("actual N and N+1 are NotConfirmed, pure refund builder rejects, only fixture mining reaches Cancelled N+2", async () => {
      const atN = await observe("cancelledAtN", cancelHash); assert.ok(atN); assert.deepEqual(atN, { kind: "NotConfirmed", reason: "InsufficientAdditionalBlocks" });
      const sourceBefore = await snapshot(), evmBefore = await evmSnapshot();
      await assert.rejects(build(atN), /^Error: Invalid Cancelled delivery: requires Confirmed\/Cancelled$/);
      assert.equal(constructionActivity, 0); unchangedSource(sourceBefore, await snapshot()); assert.deepEqual(await evmSnapshot(), evmBefore);
      evidence.stages.notConfirmedBuilder = { sourceRequest: cancellationRequest, actualObservation: atN,
        rejection: "Invalid Cancelled delivery: requires Confirmed/Cancelled", guardedConnectionMethods, rpcSigningSubmissionActivity: constructionActivity,
        sourceBefore, sourceAfter: await snapshot(), evmBefore, evmAfter: await evmSnapshot() };
      await provider.send("evm_mine", []);
      const atNPlus1 = await observe("cancelledAtNPlus1", cancelHash); assert.deepEqual(atNPlus1, atN);
      await provider.send("evm_mine", []);
      const atNPlus2 = await observe("cancelledAtNPlus2", cancelHash); assert.ok(atNPlus2?.kind === "Confirmed"); confirmed = atNPlus2;
      assert.equal(confirmed.additionalBlocks, 2n); assert.equal(confirmed.observationHead.number, confirmed.inclusion.number + 2n);
      assert.equal(confirmed.transactionHash, cancelHash); assert.deepEqual(confirmed.terms, expectedTerms);
      assert.equal(confirmed.orderId, hex(id)); assert.equal(confirmed.termsHash, hex(hash)); assert.equal(confirmed.receiptHash, hex(independent.receipt));
      assert.deepEqual(confirmed.receipt, { termsHash: pending.termsHash, terminal: 2, filledQuantity: 0n });
      destination = await evmSnapshot();
      const included = (evidence.stages.destinationCancellation as { included: typeof destination }).included;
      assert.deepEqual(destination.state, included.state); assert.equal(BigInt(destination.blockTag), BigInt(included.blockTag) + 2n);
      assert.equal(destination.blockHash, confirmed.observationHead.hash);
      unchangedSource(locked, await snapshot());
      // Even after terminal cancellation, the failed execute is never valid receipt evidence.
      await observe("failedHashAfterConfirmedCancellation", failedHash, true);
      evidence.stages.confirmationPolicy = { inclusion: confirmed.inclusion, observationHead: confirmed.observationHead,
        N: atN, NPlus1: atNPlus1, NPlus2: confirmed, additionalFixtureBlocksMined: 2, source: await snapshot(), destination };
    });
    await check("fresh live configuration, genuine cancellation and confirmed outcome build exact refund bytes and ten metas", async () => {
      await reverify();
      const fresh = await readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: latestSlot });
      assert.deepEqual(fresh, { ...cancellationRequest, contextSlot: fresh.contextSlot }); cancellationRequest = fresh;
      assert.equal(cancellationRequest.terms.minimumShares, 20_000_001n);
      const observed = await observe("freshBeforeRefund", cancelHash); assert.ok(observed?.kind === "Confirmed"); confirmed = observed;
      assert.deepEqual(confirmed.terms, expectedTerms); assert.equal(confirmed.receiptHash, hex(independent.receipt));
      assert.equal(confirmed.receipt.terminal, 2); assert.equal(confirmed.receipt.filledQuantity, 0n); assert.equal(confirmed.transactionHash, cancelHash);
      instruction = await build(confirmed); assert.equal(constructionActivity, 0);
      const d = expectedTerms.identity.domain;
      const expectedBytes = Buffer.concat([disc("global:accept_cancelled"), raw(d.sourceDomain), raw(d.destinationDomain), programId.toBuffer(),
        uint(d.chainId, 32), raw(d.settlement), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market), Buffer.from([0]),
        uint(cashAmount, 8, true), uint(minimumShares, 8, true), independent.hash, Buffer.from([2]), uint(0n, 8, true)]);
      assert.deepEqual(instruction.data, expectedBytes); assert.ok(instruction.programId.equals(programId));
      const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data); assert.ok(decoded); assert.equal(decoded.name, "acceptCancelled");
      equalDecoded(decoded.data, { args: { terms: { domain: { sourceDomain: [...raw(d.sourceDomain)], destinationDomain: [...raw(d.destinationDomain)],
        solanaProgram: programId, chainId: [...uint(d.chainId, 32)], settlement: [...raw(d.settlement)] }, user, nonce: new BN("0"),
        market: [...raw(expectedTerms.market)], outcome: 0, cashAmount: new BN("10000000"), minimumShares: new BN("20000001") },
        receipt: { termsHash: [...independent.hash], terminal: 2, filledQuantity: new BN("0") } } });
      const accountKeys = [operator.publicKey, user, config, accounting, userNonce, order, cashMint, userCashAta, escrow, TOKEN_PROGRAM_ID];
      const writable = [3, 5, 7, 8];
      assert.deepEqual(instruction.keys, accountKeys.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: writable.includes(i) })));
      const idlInstruction = program.idl.instructions.find((ix) => ix.name === "acceptCancelled"); assert.ok(idlInstruction);
      assert.deepEqual(idlInstruction.discriminator, [...disc("global:accept_cancelled")]);
      assert.deepEqual(idlInstruction.accounts.map((a) => ({ name: a.name, signer: "signer" in a && a.signer === true, writable: "writable" in a && a.writable === true })),
        ["operator", "user", "config", "accounting", "userNonce", "order", "cashMint", "userCashAta", "escrow", "tokenProgram"]
          .map((name, i) => ({ name, signer: i === 0, writable: writable.includes(i) })));
      unchangedSource(locked, await snapshot()); assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.instruction = { dataHex: instruction.data.toString("hex"), independentDataHex: expectedBytes.toString("hex"), decoded,
        accounts: instruction.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })),
        sourceRequest: cancellationRequest, observation: confirmed, rpcSigningSubmissionActivity: constructionActivity };
    });
    await check("explicit source fixture funding adds only a small operator fee balance before refund", async () => {
      const prior = await snapshot(); unchangedSource(locked, prior); assert.ok(prior.feePayer === null || prior.feePayer.lamports === 0n);
      const funding = await submit(SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: operator.publicKey, lamports: 2_000_000 }), initializer);
      assert.deepEqual(funding.events, []); assert.deepEqual(funding.inner, []);
      before = await snapshot(); assert.ok(before.feePayer); assert.equal(before.feePayer.lamports, 2_000_000n);
      for (const name of ["records", "protocolAccounts", "tokenAccounts", "signatures"] as const) assert.deepEqual(before[name], prior[name]);
      assert.deepEqual(economics(before), lockedEconomics); assert.equal(before.records.order.dataHex, expectedOrder(1).toString("hex"));
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.feeFunding = { ...funding, fundedLamports: 2_000_000n, initializerBalanceComparison: "Excluded: large genesis initializer balance is not narrowed or compared" };
      evidence.stages.beforeRefund = { source: before, economics: economics(before), destination };
    });
    await check("operator-only finalized refund emits one CancelledAccepted and exactly one escrow-to-user SPL TransferChecked", async () => {
      const delivery = await submit(instruction, operator); assert.ok(delivery.finalizedSlot > cancellationSlot);
      assert.deepEqual(delivery.requiredSigners, [operator.publicKey.toBase58()]);
      equalDecoded(delivery.events, [{ name: "cancelledAccepted", data: { order, termsHash: [...independent.hash],
        receiptHash: [...independent.receipt], cashAmount: new BN("10000000") } }]);
      assert.deepEqual(delivery.inner, [{ parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(),
        accounts: [escrow, cashMint, userCashAta, order].map((key) => key.toBase58()),
        dataHex: Buffer.concat([Buffer.from([12]), uint(cashAmount, 8, true), Buffer.from([6])]).toString("hex") }]);
      assert.deepEqual(delivery.logs?.filter((line) => /^Program .* invoke/.test(line)),
        [`Program ${programId.toBase58()} invoke [1]`, `Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`]);
      after = await snapshot(); assert.ok(after.contextSlot >= delivery.finalizedSlot); assert.deepEqual(economics(after), refundedEconomics);
      const orderBytes = expectedOrder(3), accountingBytes = expectedAccounting(cashAmount);
      assert.equal(orderBytes.length, 335); assert.equal(accountingBytes.length, 105);
      assert.equal(after.records.order.dataHex, orderBytes.toString("hex")); assert.equal(after.records.accounting.dataHex, accountingBytes.toString("hex"));
      const oldOrder = program.coder.accounts.decode("order", Buffer.from(before.records.order.dataHex, "hex"));
      const newOrder = program.coder.accounts.decode("order", Buffer.from(after.records.order.dataHex, "hex"));
      equalDecoded(newOrder, { ...oldOrder, state: { refunded: {} }, acceptedReceipt: { terminal: 2, filledQuantity: new BN("0"), receiptHash: [...independent.receipt] } });
      assert.equal(newOrder.cancellationRequested, true); assert.equal(newOrder.minimumShares.toString(), "20000001");
      const expected = structuredClone(before);
      expected.records.order.dataHex = orderBytes.toString("hex"); expected.records.accounting.dataHex = accountingBytes.toString("hex");
      for (const [name, amount] of [["userCashAta", 25_000_000n], ["escrow", 0n]] as const) {
        const bytes = Buffer.from(expected.records[name].dataHex, "hex"); bytes.writeBigUInt64LE(amount, 64); expected.records[name].dataHex = bytes.toString("hex");
      }
      assert.deepEqual(after.records, expected.records, "Full bytes and rent, immutable terms, Config, UserNonce and unrelated accounts");
      const replacement = (address: string) => Object.values(expected.records).find((r) => r.address === address)!.dataHex;
      assert.deepEqual(after.protocolAccounts, expected.protocolAccounts.map((r) => ({ ...r, dataHex: replacement(r.address) })));
      assert.deepEqual(after.tokenAccounts, expected.tokenAccounts.map((r) => ({ ...r, dataHex: replacement(r.address) })));
      history(before, after, delivery); assert.ok(before.feePayer && after.feePayer);
      assert.deepEqual(after.feePayer, { ...before.feePayer, lamports: before.feePayer.lamports - delivery.fee });
      assert.deepEqual(delivery.payerBalances, { before: before.feePayer.lamports, after: after.feePayer.lamports });
      assert.deepEqual(await evmSnapshot(), destination, "Destination state, events, native balances/nonces and block unchanged by refund");
      evidence.stages.refund = { ...delivery, source: after, economics: economics(after), decodedOrder: newOrder,
        independentOrderHex: orderBytes.toString("hex"), independentAccountingHex: accountingBytes.toString("hex"), destination: await evmSnapshot() };
    });
    await check("one identical explicit refund replay finalizes without event, CPI, counter or balance changes", async () => {
      // Retain the valid pre-refund snapshot and instruction. No fresh
      // CancelRequested read is possible or necessary after Refunded.
      assert.equal(cancellationRequest.state, "CancelRequested"); assert.equal(cancellationRequest.terms.minimumShares, 20_000_001n);
      const replay = await submit(instruction, operator); assert.notEqual(replay.signature, (evidence.stages.refund as { signature: string }).signature);
      assert.deepEqual(replay.requiredSigners, [operator.publicKey.toBase58()]); assert.deepEqual(replay.events, []); assert.deepEqual(replay.inner, []);
      assert.deepEqual(replay.logs?.filter((line) => /^Program .* invoke/.test(line)), [`Program ${programId.toBase58()} invoke [1]`]);
      const final = await snapshot(); assert.ok(final.contextSlot >= replay.finalizedSlot);
      for (const name of ["records", "protocolAccounts", "tokenAccounts"] as const) assert.deepEqual(final[name], after[name]);
      history(after, final, replay); assert.deepEqual(economics(final), refundedEconomics); assert.ok(after.feePayer && final.feePayer);
      assert.deepEqual(final.feePayer, { ...after.feePayer, lamports: after.feePayer.lamports - replay.fee });
      assert.deepEqual(replay.payerBalances, { before: after.feePayer.lamports, after: final.feePayer.lamports });
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.replay = { ...replay, reusedPreRefundInstruction: true, source: final, economics: economics(final),
        destination: await evmSnapshot(), additionalEconomicEffect: false };
    });
    await check("actual SPL accounts conserve cash supply and deposited = outstanding + refunded + reimbursed", async () => {
      const final = await snapshot(), e = economics(final); assert.deepEqual(e, refundedEconomics);
      const replaySource = (evidence.stages.replay as { source: Snapshot }).source; unchangedSource(replaySource, final);
      const tokenBalances = final.tokenAccounts.map((record) => {
        const info = { data: Buffer.from(record.dataHex, "hex"), owner: new PublicKey(record.owner), executable: record.executable, lamports: Number(record.lamports) };
        const token = unpackAccount(new PublicKey(record.address), info, TOKEN_PROGRAM_ID);
        return { address: record.address, mint: token.mint.toBase58(), amount: token.amount, owner: token.owner.toBase58() };
      });
      for (const [mint, supply] of [[cashMint, e.cashSupply], [yesMint, e.yesSupply]] as const) {
        const record = final.records[mint.equals(cashMint) ? "cashMint" : "yesMint"];
        assert.equal(unpackMint(mint, { data: Buffer.from(record.dataHex, "hex"), owner: new PublicKey(record.owner), executable: record.executable, lamports: Number(record.lamports) }, TOKEN_PROGRAM_ID).supply, supply);
        assert.equal(tokenBalances.filter((a) => a.mint === mint.toBase58()).reduce((sum, a) => sum + a.amount, 0n), supply);
      }
      assert.equal(e.cashSupply, e.userCash + e.escrow + e.executorCash); assert.equal(e.counters[0], e.escrow + e.counters[1] + e.counters[2]);
      assert.equal(e.counters[3], 0n); assert.equal(e.yesSupply, 0n); assert.equal(e.yesSupply, e.userYes);
      assert.equal(destination.state.balances.yes.holders.settlement, 0n); assert.equal(destination.state.totalCashSpent, 0n); assert.equal(destination.state.totalSharesPurchased, 0n);
      assert.equal(evmCalls.filter((c) => c.method === "eth_sendTransaction").length, 2);
      assert.equal(evmCalls.filter((c) => c.method === "evm_mine").length, 4);
      assert.equal(constructionActivity, 0); assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.conservation = { source: final, economics: e, tokenBalances, deposited: e.counters[0], outstanding: e.escrow,
        refunded: e.counters[1], reimbursed: e.counters[2], issued: e.counters[3], destination,
        failedExecuteHash: failedHash, refundEvidenceHash: cancelHash, refundCount: 1, explicitReplayCount: 1,
        explicitEvmSubmissions: 2, fixtureBlocksMined: 4, rpcSigningSubmissionActivity: constructionActivity,
        boundary: evidence.scope };
    });
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally { provider.destroy(); persist(); }
});
