import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { EvmTerms, FinalizedCancellationRequest, FinalizedPendingOrder } from "../source-order.ts";
import type { TerminalObservationRpc, TerminalReadMethod, TerminalObservationResult } from "../terminal-observation.ts";
import type { BuildAcceptFilledInstructionInput } from "../filled-delivery.ts";
const { buildAcceptFilledInstruction } = await import(new URL("../filled-delivery.ts", import.meta.url).href) as typeof import("../filled-delivery.ts");
const { readFinalizedPendingOrder, readFinalizedCancellationRequest } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { observeTerminalOutcome } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { forwardCancellationRequest } = await import(new URL("../cancellation-forwarding.ts", import.meta.url).href) as typeof import("../cancellation-forwarding.ts");
const { buildAcceptCancelledInstruction } = await import(new URL("../cancelled-delivery.ts", import.meta.url).href) as typeof import("../cancelled-delivery.ts");
const { AnchorProvider, BN, BorshInstructionCoder, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-execute-wins.sh after unchanged setup and forwarding stages");
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
function integer(value: unknown): bigint {
  assert.equal(typeof value, "string"); assert.match(value as string, /^(0|[1-9][0-9]*)$/); return BigInt(value as string);
}
function restoreTerms(value: EvmTerms): EvmTerms {
  const t = structuredClone(value);
  t.identity.domain.chainId = integer(t.identity.domain.chainId);
  t.identity.nonce = integer(t.identity.nonce); t.cashAmount = integer(t.cashAmount); t.minimumShares = integer(t.minimumShares);
  return t;
}
function credential(name: string) {
  const path = join(runtime, "credentials", `${name}.json`); assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  assert.ok(info); assert.ok(Number.isSafeInteger(info.lamports) && info.lamports >= 0);
  return { address: key.toBase58(), owner: info.owner.toBase58(), executable: info.executable,
    lamports: BigInt(info.lamports), space: info.data.length, dataHex: info.data.toString("hex") };
}

test("controlled execute-wins ordering retains cancellation history and settles exactly once", { timeout: 550_000 }, async (t) => {
  let constructing = false, constructionActivity = 0, forwardingCancellation = false;
  const forwardingCalls: { chain: string; method: string; params?: unknown }[] = [];
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (constructing) { constructionActivity++; assert.fail(`Instruction construction attempted EVM RPC: ${method}`); }
    if (forwardingCancellation) forwardingCalls.push({ chain: "EVM", method });
    return send(method, params);
  };
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      if (constructing) { constructionActivity++; assert.fail("Instruction construction attempted source RPC"); }
      if (forwardingCancellation) {
        const call = JSON.parse(String(init?.body));
        forwardingCalls.push({ chain: "Solana", method: call.method, params: call.params });
        assert.equal(call.method, "getMultipleAccounts");
        assert.equal(call.params[1].commitment, "finalized");
        assert.equal(call.params[1].minContextSlot, cancellationSlot);
      }
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const setup = json("agreement-evidence.json");
  const forwarding = json("order-forwarding-evidence.json");
  assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0);
  assert.equal(forwarding.failure, undefined); assert.equal(forwarding.checks.length, 10);
  const selected = forwarding.stages.selectedInputs;
  const creation = forwarding.stages.creation;
  const purchase = forwarding.stages.purchase;
  assert.ok(Number.isSafeInteger(creation.finalizedSlot) && creation.finalizedSlot > 0);
  assert.equal(purchase.submissionHash, purchase.submission.transactionHash);
  assert.equal(purchase.receipt.status, 1);
  const user = new PublicKey(selected.user), nonce = integer(selected.nonce);
  const expectedTerms = restoreTerms(purchase.submission.sourceOrder.terms);
  const operator = credential("operator");
  assert.equal(operator.publicKey.toBase58(), source.roles.operator);
  const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
  const wallet = new Wallet(operator);
  wallet.signTransaction = async () => { constructionActivity++; assert.fail("Adapter must not sign"); };
  wallet.signAllTransactions = async () => { constructionActivity++; assert.fail("Adapter must not sign"); };
  const anchorProvider = new AnchorProvider(connection, wallet, { commitment: "finalized" });
  anchorProvider.sendAndConfirm = async () => { constructionActivity++; assert.fail("Adapter must not submit"); };
  const program = new Program<SettlementLab>(idl, anchorProvider);
  const programId = program.programId;
  const parser = new EventParser(programId, program.coder);
  assert.equal(programId.toBase58(), source.programId);
  const keys = Object.fromEntries(Object.entries(selected.accounts).map(([name, value]) => [name, new PublicKey(value as string)]));
  assert.equal(keys.user.toBase58(), user.toBase58());
  const [yesAuthority] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), keys.config.toBuffer()], programId);
  const evidence: { scope: string; checks: string[]; stages: Record<string, unknown>; limitations: string[]; failure?: string } = {
    scope: "Controlled ordering: EVM Filled -> source cancellation request -> EVM cancel returns existing Filled -> source Settled with cancellation history retained; one explicit Filled replay.",
    checks: [], stages: { prerequisites: { setup: "agreement-evidence.json", forwarding: "order-forwarding-evidence.json", cleanup: "runner-evidence.json" },
      identifiers: { sourceUser: selected.user, nonce, creationSignature: creation.signature, creationSlot: creation.finalizedSlot,
        originalPurchaseHash: purchase.submissionHash, destinationReplayHash: forwarding.stages.duplicate.submissionHash } },
    limitations: ["Explicitly trusted operator and RPC observations; instruction encoding cannot prove EVM execution.",
      "Local finalized Solana and successful canonical EVM receipt/storage with two additional blocks; no production bridge or finality.",
      "One controlled ordering, not probabilistic concurrency or proof of all races; no automatic retries or restart recovery.",
      "Source escrow reimbursement and executor EVM prefunding are separate cash balances.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation; see runner/setup evidence."],
  };
  const persist = () => writeFileSync(join(runtime, "execute-wins-evidence.json"),
    JSON.stringify(decodedValue(evidence), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  let latestSlot = creation.finalizedSlot;
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
    const balances: Record<string, unknown> = {};
    for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
      const holders: Record<string, bigint> = {};
      for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
        holders[role] = await read(token, "balanceOf", address);
      }
      const supply: bigint = await read(token, "totalSupply");
      assert.equal(Object.values(holders).reduce((a, b) => a + b, 0n), supply);
      balances[label] = { supply, holders };
    }
    const record = await read(settlement, "orderRecord", selected.independentHashes.orderId);
    const native: Record<string, { balance: bigint; nonce: bigint }> = {};
    for (const [role, address] of Object.entries({ ...evm.roles, ...evm.contracts })) {
      native[role] = { balance: BigInt(await provider.send("eth_getBalance", [address, blockTag])),
        nonce: BigInt(await provider.send("eth_getTransactionCount", [address, blockTag])) };
    }
    const events = await provider.send("eth_getLogs", [{ fromBlock: "0x0", toBlock: blockTag, address: Object.values(evm.contracts) }]);
    const state = { balances, recordAbi: settlement.interface.encodeFunctionResult("orderRecord", [record]),
      executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement),
      venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue),
      totalCashSpent: await read(settlement, "totalCashSpent"), totalSharesPurchased: await read(settlement, "totalSharesPurchased"),
      native, events };
    assert.equal(record.status, 1n); assert.equal(record.filledQuantity, 20_000_000n);
    assert.equal(record.termsHash, selected.independentHashes.termsHash); assert.equal(record.receiptHash, selected.independentHashes.receiptHash);
    assert.equal(settlement.interface.encodeFunctionData("execute", [selected.independentHashes.orderId, record.terms]),
      settlement.interface.encodeFunctionData("execute", [selected.independentHashes.orderId, expectedTerms]));
    return { blockTag, blockHash: (await provider.send("eth_getBlockByNumber", [blockTag, false])).hash, state };
  }
  async function observe(label: string, transactionHash: string) {
    const calls: { method: TerminalReadMethod; params: unknown[]; response?: unknown }[] = [];
    const rpc: TerminalObservationRpc = { async send(method, params) {
      assert.ok(["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"].includes(method));
      const call: typeof calls[number] = { method, params: structuredClone(params) }; calls.push(call);
      const response = await provider.send(method, params); call.response = structuredClone(response); return response;
    } };
    const result = await observeTerminalOutcome({ provider: rpc, expectedConfiguration: live, orderId: pending.orderId,
      termsHash: pending.termsHash, terms: pending.terms, transactionHash });
    evidence.stages[label] = { result, calls, mining: 0, submissions: 0 }; persist();
    assert.equal(result.kind, "Confirmed"); assert.ok(result.kind === "Confirmed");
    assert.equal(result.transactionHash, transactionHash); assert.equal(result.orderId, pending.orderId);
    assert.equal(result.termsHash, pending.termsHash); assert.deepEqual(result.terms, pending.terms);
    assert.deepEqual(result.receipt, { termsHash: pending.termsHash, terminal: 1, filledQuantity: 20_000_000n });
    assert.ok(result.additionalBlocks >= 2n); assert.equal(result.additionalBlocks, result.observationHead.number - result.inclusion.number);
    assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber",
      "eth_getBlockByNumber", ...Array(6).fill("eth_call"), "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
    const reads = calls.filter((call) => call.method === "eth_call");
    for (const [index, hash] of [result.inclusion.hash, result.observationHead.hash].entries()) {
      assert.deepEqual(reads.slice(index * 3, index * 3 + 3).map((call) => call.params[1]), Array(3).fill({ blockHash: hash, requireCanonical: true }));
    }
    return result;
  }
  async function submit(instruction: TransactionInstruction, payer: Keypair) {
    const block = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ ...block, feePayer: payer.publicKey }).add(instruction); tx.sign(payer);
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
          assert.equal(after, before - BigInt(txRecord.meta!.fee)); return { before, after };
        })();
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
  let live: LiveConfigurationObservation;
  let pending: FinalizedPendingOrder;
  let confirmed: Extract<TerminalObservationResult, { kind: "Confirmed" }>;
  let cancellationSlot = 0, cancellationRequest: FinalizedCancellationRequest, locked: Snapshot;
  let before: Snapshot, after: Snapshot, destination: Awaited<ReturnType<typeof evmSnapshot>>;
  let instruction: TransactionInstruction;
  let independent: { id: Buffer; hash: Buffer; receipt: Buffer };
  async function build(input: BuildAcceptFilledInstructionInput) {
    constructing = true;
    try { return await buildAcceptFilledInstruction(input); } finally { constructing = false; }
  }
  const input = (): BuildAcceptFilledInstructionInput => ({ program, expectedConfiguration: live, sourceOrder: pending, observation: confirmed });
  try {
    await check("recover real identifiers and re-read finalized Pending order on unchanged deployments", async () => {
      live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: creation.finalizedSlot });
      assert.equal(live.solana.config.dataHex, setup.observed.agreement.solana.config.dataHex);
      pending = await readFinalizedPendingOrder({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: creation.finalizedSlot });
      assert.deepEqual(pending.terms, expectedTerms); assert.deepEqual(pending.accounts, purchase.submission.sourceOrder.accounts);
      assert.deepEqual(expectedTerms, { identity: { domain: { sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
        solanaProgram: hex(programId.toBuffer()), chainId: integer(evm.chainId), settlement: evm.contracts.settlement.toLowerCase() },
        user: hex(user.toBuffer()), nonce }, market: evm.market, outcome: 0, cashAmount: 10_000_000n, minimumShares: 20_000_000n });
      assert.equal(pending.orderId, selected.independentHashes.orderId); assert.equal(pending.termsHash, selected.independentHashes.termsHash);
      const initial = await snapshot();
      assert.deepEqual(economics(initial), { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      assert.equal(initial.records.order.dataHex, creation.snapshot.state.accounts[3].account.dataHex);
      assert.equal(initial.records.userNonce.dataHex, creation.snapshot.state.accounts[2].account.dataHex);
      const decoded = program.coder.accounts.decode("order", Buffer.from(initial.records.order.dataHex, "hex"));
      assert.deepEqual(decoded.state, { pending: {} }); assert.equal(decoded.cancellationRequested, false); assert.equal(decoded.acceptedReceipt, null);
      evidence.stages.initialPending = { snapshot: initial, economics: economics(initial) };
      evidence.stages.sourceReader = pending; evidence.stages.liveConfiguration = live;
    });
    await check("fresh observer confirms ORIGINAL purchase with independent SHA-256 preimages", async () => {
      confirmed = await observe("originalPurchaseBeforeCancellation", purchase.submissionHash);
      assert.equal(confirmed.transactionHash, purchase.submissionHash); assert.equal(confirmed.receipt.terminal, 1);
      const d = expectedTerms.identity.domain;
      const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
      const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
      const id = sha(identityPreimage);
      const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, id, user.toBuffer(), uint(nonce, 8), raw(expectedTerms.market),
        Buffer.from([0]), uint(expectedTerms.cashAmount, 8), uint(expectedTerms.minimumShares, 8)]);
      const hash = sha(termsPreimage);
      const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), hash, Buffer.from([1]), uint(20_000_000n, 8)]);
      const receipt = sha(receiptPreimage); independent = { id, hash, receipt };
      assert.deepEqual([identityPreimage.length, termsPreimage.length, receiptPreimage.length], [196, 277, 49]);
      assert.equal(confirmed.orderId, hex(id)); assert.equal(confirmed.termsHash, hex(hash)); assert.equal(confirmed.receiptHash, hex(receipt));
      const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
      const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
      assert.ok(order.equals(keys.order) && escrow.equals(keys.escrow));
      const expectedOrder = Buffer.concat([disc("account:Order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market),
        Buffer.from([0]), uint(10_000_000n, 8, true), uint(20_000_000n, 8, true), id, hash,
        keys.userCashAta.toBuffer(), keys.userYesAta.toBuffer(), escrow.toBuffer(), Buffer.from([0, 0, 0, orderBump, escrowBump]), Buffer.alloc(41)]);
      const initial = (evidence.stages.initialPending as { snapshot: Snapshot }).snapshot;
      assert.equal(initial.records.order.dataHex, expectedOrder.toString("hex"));
      const [, nonceBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), keys.config.toBuffer(), user.toBuffer()], programId);
      assert.equal(initial.records.userNonce.dataHex, Buffer.concat([disc("account:UserNonce"), keys.config.toBuffer(), user.toBuffer(),
        uint(nonce + 1n, 8, true), Buffer.from([nonceBump])]).toString("hex"));
      const [, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), keys.config.toBuffer()], programId);
      assert.equal(accountingBump, source.bumps.accounting);
      assert.equal(initial.records.accounting.dataHex, Buffer.concat([disc("account:Accounting"), keys.config.toBuffer(),
        ...[10_000_000n, 0n, 0n, 0n].map((value) => uint(value, 16, true)), Buffer.from([accountingBump])]).toString("hex"));
      assert.deepEqual(confirmed.terms, pending.terms); assert.ok(confirmed.additionalBlocks >= 2n);
      evidence.stages.observation = confirmed;
      evidence.stages.independentHashes = { orderId: hex(id), termsHash: hex(hash), receiptHash: hex(receipt),
        identityPreimage: hex(identityPreimage), termsPreimage: hex(termsPreimage), receiptPreimage: hex(receiptPreimage) };
      const realReceipt = await provider.getTransactionReceipt(purchase.submissionHash); assert.ok(realReceipt); assert.equal(realReceipt.status, 1);
      evidence.stages.evmGas = { originalPurchaseGas: realReceipt.gasUsed * realReceipt.gasPrice,
        forwardingReplayGas: forwarding.stages.duplicate.gasCost };
    });
    await check("actual IDL decode and independent Borsh/account encoding match pure adapter", async () => {
      instruction = await build(input()); assert.equal(constructionActivity, 0);
      const d = expectedTerms.identity.domain;
      const expectedBytes = Buffer.concat([disc("global:accept_filled"), raw(d.sourceDomain), raw(d.destinationDomain), programId.toBuffer(),
        uint(d.chainId, 32), raw(d.settlement), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market), Buffer.from([0]),
        uint(10_000_000n, 8, true), uint(20_000_000n, 8, true), independent.hash, Buffer.from([1]), uint(20_000_000n, 8, true)]);
      assert.deepEqual(instruction.data, expectedBytes); assert.ok(instruction.programId.equals(programId));
      const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data); assert.ok(decoded); assert.equal(decoded.name, "acceptFilled");
      equalDecoded(decoded.data, { args: { terms: { domain: { sourceDomain: [...raw(d.sourceDomain)], destinationDomain: [...raw(d.destinationDomain)],
        solanaProgram: programId, chainId: [...uint(31337n, 32)], settlement: [...raw(d.settlement)] }, user, nonce: new BN(nonce.toString()),
        market: [...raw(expectedTerms.market)], outcome: 0, cashAmount: new BN("10000000"), minimumShares: new BN("20000000") },
      receipt: { termsHash: [...independent.hash], terminal: 1, filledQuantity: new BN("20000000") } } });
      const accountKeys = [operator.publicKey, user, keys.config, keys.accounting, keys.userNonce, keys.order, keys.cashMint, keys.yesMint,
        keys.userYesAta, keys.escrow, keys.executorCashAta, yesAuthority, TOKEN_PROGRAM_ID];
      const writable = [3, 5, 7, 8, 9, 10];
      assert.deepEqual(instruction.keys, accountKeys.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: writable.includes(index) })));
      evidence.stages.instruction = { dataHex: instruction.data.toString("hex"), independentDataHex: expectedBytes.toString("hex"),
        accounts: instruction.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })), activity: constructionActivity };
      unchangedSource((evidence.stages.initialPending as { snapshot: Snapshot }).snapshot, await snapshot());
      evidence.stages.retainedInstruction = { builtFromState: pending.state, pendingContextSlot: pending.contextSlot, submitted: false };
    });
    await check("original user cancels after EVM purchase; only intent, history and user fee change", async () => {
      const originalUser = credential("forwarding-user"); assert.ok(originalUser.publicKey.equals(user));
      const beforeCancel = await snapshot(), destinationBefore = await evmSnapshot();
      const cancel = await program.methods.requestCancel(new BN(nonce.toString()), [...independent.hash])
        .accountsStrict({ user, config: keys.config, order: keys.order }).instruction();
      assert.deepEqual(cancel.data, Buffer.concat([disc("global:request_cancel"), uint(nonce, 8, true), independent.hash]));
      assert.ok(cancel.programId.equals(programId));
      assert.deepEqual(cancel.keys, [user, keys.config, keys.order].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i === 2 })));
      // The recovered user credential is used only for this one real request_cancel.
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
      assert.deepEqual(cancellationRequest, { ...pending, contextSlot: cancellationRequest.contextSlot, state: "CancelRequested", cancellationRequested: true });
      assert.deepEqual(await evmSnapshot(), destinationBefore, "User cancellation cannot undo destination purchase");
      evidence.stages.sourceCancellation = { ...cancellation, before: beforeCancel, after: locked, request: cancellationRequest,
        instruction: { dataHex: cancel.data.toString("hex"), metas: cancel.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })) },
        economics: economics(locked), destinationBefore, destinationAfter: await evmSnapshot() };
    });
    await check("one destination cancel preserves Filled, spending, custody and events; only operator gas and nonce change", async () => {
      const beforeCancel = await evmSnapshot();
      const evmOperator = await provider.getSigner(evm.roles.operator);
      forwardingCancellation = true;
      let forwarded;
      try { forwarded = await forwardCancellationRequest({ provider, operator: evmOperator, connection, expectedConfiguration: live,
        user, nonce, minFinalizedSlot: cancellationSlot }); } finally { forwardingCancellation = false; }
      assert.deepEqual(forwarded.sourceRequest, { ...cancellationRequest, contextSlot: forwarded.sourceRequest.contextSlot });
      assert.ok(forwarded.sourceRequest.contextSlot >= cancellationSlot);
      assert.equal(forwardingCalls.filter((call) => call.method === "eth_sendTransaction").length, 1);
      const receipt = await provider.waitForTransaction(forwarded.transactionHash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, 1);
      const transaction = await provider.send("eth_getTransactionByHash", [forwarded.transactionHash]);
      const rawReceipt = await provider.send("eth_getTransactionReceipt", [forwarded.transactionHash]);
      assert.equal(rawReceipt.status, "0x1"); assert.equal(rawReceipt.transactionHash, forwarded.transactionHash);
      assert.equal(transaction.from, evm.roles.operator.toLowerCase()); assert.equal(transaction.to, evm.contracts.settlement.toLowerCase());
      assert.equal(transaction.value, "0x0"); assert.equal(BigInt(transaction.chainId), 31337n);
      assert.equal(transaction.input, settlement.interface.encodeFunctionData("cancel", [pending.orderId, expectedTerms]));
      assert.equal(BigInt(transaction.nonce), beforeCancel.state.native.operator.nonce);
      assert.equal(receipt.logs.length, 0, "No terminal, token, venue or allowance event");
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const expected = structuredClone(beforeCancel.state);
      expected.native.operator.balance -= gasCost; expected.native.operator.nonce += 1n;
      const included = await evmSnapshot(); assert.deepEqual(included.state, expected);
      assert.equal(BigInt(included.blockTag), BigInt(rawReceipt.blockNumber)); assert.equal(included.blockHash, rawReceipt.blockHash);
      assert.equal(BigInt(included.blockTag), BigInt(beforeCancel.blockTag) + 1n);
      // Mining belongs to this fixture, never the observer/forwarder. Only N+2 blocks.
      const needed = BigInt(rawReceipt.blockNumber) + 2n - BigInt(included.blockTag); assert.equal(needed, 2n);
      for (let i = 0n; i < needed; i++) await provider.send("evm_mine", []);
      destination = await evmSnapshot(); assert.deepEqual(destination.state, expected);
      assert.equal(BigInt(destination.blockTag), BigInt(rawReceipt.blockNumber) + 2n);
      const original = await observe("originalPurchaseAfterDestinationCancel", purchase.submissionHash);
      const later = await observe("laterCancelConfirmedFilled", forwarded.transactionHash);
      for (const result of [original, later]) assert.equal(result.receiptHash, hex(independent.receipt));
      const terminal = (value: typeof original) => ({ orderId: value.orderId, termsHash: value.termsHash, receiptHash: value.receiptHash, terms: value.terms, receipt: value.receipt });
      assert.deepEqual(terminal(original), terminal(later));
      const events = await settlement.queryFilter(settlement.filters.TerminalRecorded(), 0, "latest"); assert.equal(events.length, 1);
      const event = settlement.interface.parseLog(events[0]); assert.ok(event);
      assert.equal(events[0].transactionHash, purchase.submissionHash);
      assert.deepEqual([...event.args], [pending.orderId, pending.termsHash, 1n, 20_000_000n, hex(independent.receipt)]);
      unchangedSource(locked, await snapshot()); assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.destinationCancellation = { forwarded, transaction, receipt: rawReceipt, gasCost, before: beforeCancel, included,
        additionalBlocksMined: needed, confirmedSnapshot: destination, original, later, terminalEvents: events.map((e) => e.toJSON()), forwardingCalls };
    });
    await check("genuine CancelRequested plus Confirmed/Filled cannot build refund and has zero activity", async () => {
      const fresh = await readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: cancellationSlot });
      assert.deepEqual(fresh, { ...cancellationRequest, contextSlot: fresh.contextSlot });
      const actual = await observe("refundEligibilityActualFilled", purchase.submissionHash);
      const beforeReject = await snapshot(), evmBeforeReject = await evmSnapshot();
      constructing = true;
      try { await assert.rejects(buildAcceptCancelledInstruction({ program, expectedConfiguration: live, sourceRequest: fresh, observation: actual }),
        /^Error: Invalid Cancelled delivery: requires Confirmed\/Cancelled$/); } finally { constructing = false; }
      assert.equal(constructionActivity, 0); unchangedSource(beforeReject, await snapshot()); assert.deepEqual(await evmSnapshot(), evmBeforeReject);
      evidence.stages.refundIneligible = { sourceRequest: fresh, observation: actual, rejection: "Invalid Cancelled delivery: requires Confirmed/Cancelled",
        rpcSigningSubmissionActivity: constructionActivity, sourceBefore: beforeReject, sourceAfter: await snapshot(), destination: evmBeforeReject };
    });
    await check("fund only small operator fee balance and verify exact pre-delivery economics", async () => {
      const fresh = await observe("originalPurchaseImmediatelyBeforeDelivery", purchase.submissionHash);
      assert.equal(fresh.receiptHash, hex(independent.receipt)); assert.deepEqual(fresh.terms, confirmed.terms); assert.deepEqual(fresh.receipt, confirmed.receipt);
      assert.equal(instruction.data.toString("hex"), (evidence.stages.instruction as { dataHex: string }).dataHex);
      const current = await readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: cancellationSlot });
      assert.deepEqual(current, { ...cancellationRequest, contextSlot: current.contextSlot }); unchangedSource(locked, await snapshot());
      const initializer = credential("initializer");
      const prior = await connection.getAccountInfo(operator.publicKey, { commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(prior === null || prior.lamports === 0);
      const funding = await submit(SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: operator.publicKey, lamports: 2_000_000 }), initializer);
      before = await snapshot(); assert.equal(before.feePayer!.lamports, 2_000_000n);
      for (const name of ["records", "protocolAccounts", "tokenAccounts", "signatures"] as const) assert.deepEqual(before[name], locked[name]);
      assert.deepEqual(economics(before), { userCash: 15_000_000n, escrow: 10_000_000n, executorCash: 0n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      const o = program.coder.accounts.decode("order", Buffer.from(before.records.order.dataHex, "hex"));
      assert.deepEqual(o.state, { cancelRequested: {} }); assert.equal(o.acceptedReceipt, null); assert.equal(o.cancellationRequested, true);
      assert.equal(before.records.config.dataHex, live.solana.config.dataHex);
      assert.equal(before.records.order.dataHex, locked.records.order.dataHex);
      assert.equal(before.records.userNonce.dataHex, creation.snapshot.state.accounts[2].account.dataHex);
      assert.deepEqual(await evmSnapshot(), destination);
      assert.deepEqual(destination.state.balances, { usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 90_000_000n, venue: 10_000_000n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 180_000_000n, settlement: 20_000_000n } } });
      assert.equal(destination.state.executorAllowance, 90_000_000n); assert.equal(destination.state.venueAllowance, 0n);
      assert.equal(destination.state.totalCashSpent, 10_000_000n); assert.equal(destination.state.totalSharesPurchased, 20_000_000n);
      evidence.stages.feeFunding = { ...funding, fundedLamports: 2_000_000n, initializerBalanceComparison: "Excluded: large genesis balance is not narrowed or compared" };
      evidence.stages.beforeDelivery = { source: before, economics: economics(before), evm: destination };
    });
    await check("finalized accept_filled persists complete Settled record, one event and exact SPL effects", async () => {
      const delivery = await submit(instruction, operator);
      assert.deepEqual(delivery.requiredSigners, [operator.publicKey.toBase58()]);
      assert.notEqual(delivery.signature, creation.signature); assert.ok(delivery.finalizedSlot > creation.finalizedSlot);
      equalDecoded(delivery.events, [{ name: "filledAccepted", data: { order: keys.order, termsHash: [...independent.hash],
        receiptHash: [...independent.receipt], cashAmount: new BN("10000000"), filledQuantity: new BN("20000000") } }]);
      assert.deepEqual(delivery.inner, [
        { parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(), accounts: [keys.yesMint, keys.userYesAta, yesAuthority].map((k) => k.toBase58()),
          dataHex: Buffer.concat([Buffer.from([14]), uint(20_000_000n, 8, true), Buffer.from([6])]).toString("hex") },
        { parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(), accounts: [keys.escrow, keys.cashMint, keys.executorCashAta, keys.order].map((k) => k.toBase58()),
          dataHex: Buffer.concat([Buffer.from([12]), uint(10_000_000n, 8, true), Buffer.from([6])]).toString("hex") } ]);
      after = await snapshot(); assert.ok(after.contextSlot >= delivery.finalizedSlot);
      assert.equal(delivery.payerBalances?.before, before.feePayer!.lamports);
      history(before, after, delivery);
      assert.deepEqual(economics(after), { userCash: 15_000_000n, escrow: 0n, executorCash: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 20_000_000n, yesSupply: 20_000_000n, counters: [10_000_000n, 0n, 10_000_000n, 20_000_000n] });
      const oldOrder = program.coder.accounts.decode("order", Buffer.from(before.records.order.dataHex, "hex"));
      const newOrder = program.coder.accounts.decode("order", Buffer.from(after.records.order.dataHex, "hex"));
      equalDecoded(newOrder, { ...oldOrder, state: { settled: {} }, acceptedReceipt: { terminal: 1,
        filledQuantity: new BN("20000000"), receiptHash: [...independent.receipt] } });
      // Independent complete Borsh terminal record, including bumps and padding.
      const [, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
      const [, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), keys.order.toBuffer()], programId);
      const terminalBytes = Buffer.concat([disc("account:Order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market),
        Buffer.from([0]), uint(10_000_000n, 8, true), uint(20_000_000n, 8, true), independent.id, independent.hash,
        keys.userCashAta.toBuffer(), keys.userYesAta.toBuffer(), keys.escrow.toBuffer(), Buffer.from([2, 1, 1, 1]), uint(20_000_000n, 8, true),
        independent.receipt, Buffer.from([orderBump, escrowBump])]);
      assert.equal(terminalBytes.length, 335); assert.equal(after.records.order.dataHex, terminalBytes.toString("hex"));
      assert.equal(newOrder.cancellationRequested, true);
      const accountingBytes = Buffer.concat([disc("account:Accounting"), keys.config.toBuffer(), ...[10_000_000n, 0n, 10_000_000n, 20_000_000n].map((n) => uint(n, 16, true)),
        Buffer.from([source.bumps.accounting])]);
      assert.equal(after.records.accounting.dataHex, accountingBytes.toString("hex"));
      const expected = structuredClone(before);
      for (const [name, offset, amount] of [["yesMint", 36, 20_000_000n], ["userYesAta", 64, 20_000_000n],
        ["escrow", 64, 0n], ["executorCashAta", 64, 10_000_000n]] as const) {
        const b = Buffer.from(expected.records[name].dataHex, "hex"); b.writeBigUInt64LE(amount, offset); expected.records[name].dataHex = b.toString("hex");
      }
      expected.records.order.dataHex = terminalBytes.toString("hex"); expected.records.accounting.dataHex = accountingBytes.toString("hex");
      assert.deepEqual(after.records, expected.records);
      assert.deepEqual(after.protocolAccounts, expected.protocolAccounts.map((record) => ({ ...record,
        dataHex: Object.values(expected.records).find((r) => r.address === record.address)!.dataHex })));
      assert.deepEqual(after.tokenAccounts, before.tokenAccounts.map((record) => ({ ...record,
        dataHex: Object.values(expected.records).find((r) => r.address === record.address)?.dataHex ?? record.dataHex })));
      assert.deepEqual(after.feePayer, { ...before.feePayer, lamports: before.feePayer!.lamports - delivery.fee });
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.delivery = { ...delivery, source: after, economics: economics(after), evm: await evmSnapshot(), decodedOrder: newOrder };
    });
    await check("explicit identical instruction replay finalizes without CPI, event or economic change", async () => {
      // Do not invoke the Pending-only reader or rebuild terminal eligibility.
      const replay = await submit(instruction, operator);
      const delivered = evidence.stages.delivery as { signature: string };
      assert.notEqual(replay.signature, delivered.signature); assert.deepEqual(replay.requiredSigners, [operator.publicKey.toBase58()]);
      assert.deepEqual(replay.events, []); assert.deepEqual(replay.inner, []);
      assert.ok(!(replay.logs ?? []).some((line) => /invoke \[[2-9]/.test(line)));
      const final = await snapshot(); assert.ok(final.contextSlot >= replay.finalizedSlot);
      assert.deepEqual(final.records, after.records); assert.deepEqual(final.protocolAccounts, after.protocolAccounts);
      assert.deepEqual(final.tokenAccounts, after.tokenAccounts); history(after, final, replay);
      assert.equal(replay.payerBalances?.before, after.feePayer!.lamports);
      assert.deepEqual(economics(final), economics(after));
      assert.deepEqual(final.feePayer, { ...after.feePayer, lamports: after.feePayer!.lamports - replay.fee });
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.replay = { ...replay, source: final, economics: economics(final), evm: await evmSnapshot(), additionalEconomicEffect: false };
    });
    await check("finalized SPL decoding conserves source cash and matches YES issuance to EVM custody", async () => {
      const final = await snapshot();
      const e = economics(final);
      const tokenBalances = final.tokenAccounts.map((record) => {
        const bytes = Buffer.from(record.dataHex, "hex");
        return { address: record.address, mint: new PublicKey(bytes.subarray(0, 32)).toBase58(), amount: bytes.readBigUInt64LE(64) };
      });
      for (const [mint, supply] of [[keys.cashMint, e.cashSupply], [keys.yesMint, e.yesSupply]] as const) {
        assert.equal(tokenBalances.filter((a) => a.mint === mint.toBase58()).reduce((sum, a) => sum + a.amount, 0n), supply);
      }
      assert.equal(e.cashSupply, e.userCash + e.escrow + e.executorCash);
      assert.equal(e.counters[0], e.escrow + e.counters[1] + e.counters[2]);
      assert.equal(e.counters[3], e.yesSupply); assert.equal(e.yesSupply, e.userYes);
      assert.equal(e.yesSupply, confirmed.receipt.filledQuantity); assert.equal(e.yesSupply, destination.state.totalSharesPurchased);
      assert.equal(e.counters[1], 0n);
      assert.equal(await yes.getFunction("balanceOf").staticCall(evm.contracts.settlement, { blockTag: destination.blockTag }), e.userYes);
      const response = await connection.getMultipleAccountsInfoAndContext([keys.cashMint, keys.yesMint, keys.userYesAta, keys.executorCashAta, keys.escrow], {
        commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(response.context.slot >= latestSlot);
      assert.equal(unpackMint(keys.cashMint, response.value[0]!, TOKEN_PROGRAM_ID).supply, 25_000_000n);
      assert.equal(unpackMint(keys.yesMint, response.value[1]!, TOKEN_PROGRAM_ID).supply, 20_000_000n);
      for (const [index, key, owner, amount] of [[2, keys.userYesAta, user, 20_000_000n],
        [3, keys.executorCashAta, new PublicKey(source.roles.executor), 10_000_000n], [4, keys.escrow, keys.order, 0n]] as const) {
        const token = unpackAccount(key, response.value[index]!, TOKEN_PROGRAM_ID); assert.ok(token.owner.equals(owner)); assert.equal(token.amount, amount);
      }
      assert.equal(constructionActivity, 0);
      evidence.stages.conservation = { contextSlot: response.context.slot, sourceCash: { supply: e.cashSupply, user: e.userCash, escrow: e.escrow, executor: e.executorCash },
        tokenBalances, accounting: e.counters, sourceYesSupply: e.yesSupply, sourceUserYes: e.userYes, evmOrderCustodyBacking: confirmed.receipt.filledQuantity,
        separateFeePayerFinalLamports: final.feePayer!.lamports, unchangedEvmState: true };
    });
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally { provider.destroy(); persist(); }
});
