import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { WorkerInput, WorkerOutput } from "../recovery-observation-worker.ts";

const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-recovery-observation.sh after unchanged setup and forwarding suites");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (name: string) => JSON.parse(readFileSync(join(runtime, name), "utf8"));
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
const serialize = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const publicValue = <T>(value: T): T => JSON.parse(serialize(value));
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const sha = (value: Uint8Array) => `0x${createHash("sha256").update(value).digest("hex")}`;
function uint(value: bigint, width: number) {
  assert.ok(value >= 0n && value < (1n << BigInt(width * 8)));
  return Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  return { address: key.toBase58(), account: info && { owner: info.owner.toBase58(), executable: info.executable,
    lamports: info.lamports, space: info.data.length, dataHex: info.data.toString("hex") } };
}
type ForwardingEvidence = { checks: string[]; failure?: unknown; stages: {
  selectedInputs: { user: string; nonce: string; cashAmount: string; minimumShares: string };
  creation: { finalizedSlot: number };
  purchase: { submissionHash: string };
  duplicate: { submissionHash: string };
} };
type Attempt = { label: string; stdin: WorkerInput; parentProcessId: number; processId?: number;
  exitCode?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string;
  output?: WorkerOutput; before?: unknown; after?: unknown; unchanged?: boolean; failure?: string };

test("fresh processes recover original Filled without saved hashes and preserve both chains", { timeout: 550_000 }, async (t) => {
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const forwarding = json("order-forwarding-evidence.json") as ForwardingEvidence;
  const evidence: { scope: string; limitations: string[]; checks: string[]; stages: Record<string, unknown>;
    attempts: Attempt[]; childrenStopped?: boolean; failure?: string } = {
    scope: "Read-only recovery from fresh application processes after the forwarding suite exited, with both chains still running.",
    limitations: ["Trusted RPC/operator and local finalized Solana / EVM N+2 observations, not production finality or a bridge proof.",
      "No machine/node restart or abrupt broadcast crash; no receipt delivery, resumed settlement, automatic retry or recovery resend.",
      "The earlier forwarding fixture contains one explicit eventless EVM replay. Cancelled and already-paid source restart cases remain separate.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation remains."],
    checks: [], stages: {}, attempts: [],
  };
  const persist = () => writeFileSync(join(runtime, "recovery-observation-live-evidence.json"), JSON.stringify(evidence,
    (_, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2) + "\n");
  const children = new Set<ChildProcess>();
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      assert.ok(["getMultipleAccounts", "getProgramAccounts", "getSignaturesForAddress"].includes(call.method));
      assert.equal(call.params[1].commitment, "finalized");
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  const send = provider.send.bind(provider);
  provider.send = (method: string, params: unknown[] | Record<string, unknown>) => {
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getLogs", "eth_getTransactionReceipt",
      "eth_getTransactionByHash", "eth_getBalance", "eth_getTransactionCount"].includes(method), `Forbidden parent RPC: ${method}`);
    return send(method, params);
  };
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); }
      catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  try {
    assert.equal(forwarding.failure, undefined); assert.ok(forwarding.checks.length > 0);
    const selected = forwarding.stages.selectedInputs;
    const user = new PublicKey(selected.user), nonce = BigInt(selected.nonce);
    const cashAmount = BigInt(selected.cashAmount), minimumShares = BigInt(selected.minimumShares);
    const creationSlot = forwarding.stages.creation.finalizedSlot;
    assert.ok(Number.isSafeInteger(creationSlot) && creationSlot > 0);
    assert.equal(cashAmount, 10_000_000n); assert.equal(minimumShares, 20_000_000n);
    const programId = new PublicKey(source.programId), config = new PublicKey(source.accounts.config);
    const domain = Buffer.concat([raw(evm.sourceDomain), raw(evm.destinationDomain), programId.toBuffer(), uint(BigInt(evm.chainId), 32), raw(evm.contracts.settlement)]);
    assert.equal(domain.length, 148);
    const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
    assert.equal(identityPreimage.length, 196);
    const orderId = sha(identityPreimage);
    const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, raw(orderId), user.toBuffer(), uint(nonce, 8),
      raw(evm.market), Buffer.from([0]), uint(cashAmount, 8), uint(minimumShares, 8)]);
    assert.equal(termsPreimage.length, 277);
    const termsHash = sha(termsPreimage);
    const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), raw(termsHash), Buffer.from([1]), uint(20_000_000n, 8)]);
    assert.equal(receiptPreimage.length, 49);
    const receiptHash = sha(receiptPreimage);
    const terms = publicValue({ identity: { domain: { sourceDomain: evm.sourceDomain.toLowerCase(), destinationDomain: evm.destinationDomain.toLowerCase(),
      solanaProgram: hex(programId.toBytes()), chainId: evm.chainId, settlement: evm.contracts.settlement.toLowerCase() },
      user: hex(user.toBytes()), nonce: selected.nonce }, market: evm.market.toLowerCase(), outcome: 0,
      cashAmount: selected.cashAmount, minimumShares: selected.minimumShares });
    const canonicalReceipt = { termsHash, terminal: 1, filledQuantity: "20000000" };
    const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], programId);
    const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
    const cashMint = new PublicKey(source.mints.cash), yesMint = new PublicKey(source.mints.yes);
    const userCash = getAssociatedTokenAddressSync(cashMint, user), userYes = getAssociatedTokenAddressSync(yesMint, user);
    const accounts = { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
      userCashAta: userCash.toBase58(), userYesAta: userYes.toBase58() };
    const keys = [config, new PublicKey(source.accounts.accounting), userNonce, order, escrow, cashMint, yesMint,
      new PublicKey(source.accounts.executorCashAta), userCash, userYes, user, programId, new PublicKey(source.programData),
      ...Object.values(source.roles).map((key) => new PublicKey(key))];
    const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
    const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider);
    const yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
    const originalHash = forwarding.stages.purchase.submissionHash, replayHash = forwarding.stages.duplicate.submissionHash;
    assert.notEqual(originalHash, replayHash);
    const original = await provider.send("eth_getTransactionReceipt", [originalHash]);
    const replay = await provider.send("eth_getTransactionReceipt", [replayHash]);
    assert.ok(original && replay); assert.equal(original.status, "0x1"); assert.equal(replay.status, "0x1");
    assert.deepEqual(replay.logs, [], "The fixture's existing replay is eventless");
    const originalBlock = BigInt(original.blockNumber), replayBlock = BigInt(replay.blockNumber);
    assert.ok(replayBlock > originalBlock);
    const head = await provider.send("eth_getBlockByNumber", ["latest", false]); assert.ok(head);
    const toBlock = BigInt(head.number), fromBlock = toBlock > 2047n ? toBlock - 2047n : 0n;
    assert.ok(originalBlock >= fromBlock && replayBlock <= toBlock && toBlock >= originalBlock + 2n);
    const input: WorkerInput = { user: selected.user, nonce: selected.nonce, minFinalizedSlot: creationSlot,
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString() };
    evidence.stages.independentExpectations = { terms, orderId, termsHash, canonicalReceipt, receiptHash, accounts,
      identityPreimage: hex(identityPreimage), termsPreimage: hex(termsPreimage), receiptPreimage: hex(receiptPreimage),
      originalHash, replayHash, original, replay, head, publicInput: input };

    async function sourceSnapshot() {
      const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot: creationSlot });
      assert.ok(response.context.slot >= creationSlot);
      const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
      assert.equal(protocol.value.length, 4);
      const activity = (await connection.getSignaturesForAddress(programId, { limit: 100 }, "finalized"))
        .map(({ signature, slot, err, confirmationStatus }) => ({ signature, slot, err, confirmationStatus }));
      assert.ok(activity.length < 100, "Activity snapshot must not be truncated");
      const tokens = [];
      for (const mint of [cashMint, yesMint]) {
        const info = response.value[keys.findIndex((key) => key.equals(mint))]; assert.ok(info);
        const supply = unpackMint(mint, info, TOKEN_PROGRAM_ID).supply;
        const holders = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { commitment: "finalized", minContextSlot: response.context.slot,
          filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] });
        const balances = holders.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), amount: unpackAccount(pubkey, account, TOKEN_PROGRAM_ID).amount }))
          .sort((a, b) => a.address.localeCompare(b.address));
        assert.equal(balances.reduce((sum, holder) => sum + holder.amount, 0n), supply);
        tokens.push({ mint: mint.toBase58(), supply, balances,
          accounts: holders.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)) });
      }
      function token(index: number) { const info = response.value[index]; assert.ok(info); return unpackAccount(keys[index], info, TOKEN_PROGRAM_ID).amount; }
      const accounting = response.value[1]; assert.ok(accounting);
      const counters = Array.from({ length: 4 }, (_, i) => accounting.data.readBigUInt64LE(40 + i * 16)
        + (accounting.data.readBigUInt64LE(48 + i * 16) << 64n));
      const economics = { userCash: token(8), escrow: token(4), cashSupply: tokens[0].supply, userYes: token(9), yesSupply: tokens[1].supply,
        executorCash: token(7), counters };
      assert.deepEqual(economics, { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      return { contextSlot: response.context.slot, protocolContextSlot: protocol.context.slot, state: {
        accounts: response.value.map((info, i) => publicAccount(keys[i], info)),
        protocolAccounts: protocol.value.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)),
        activity, tokens, economics } };
    }
    async function destinationSnapshot() {
      const at = await provider.send("eth_getBlockByNumber", ["latest", false]); assert.ok(at);
      const tag = toQuantity(BigInt(at.number));
      const read = (contract: Contract, name: string, ...args: unknown[]) => contract.getFunction(name).staticCall(...args, { blockTag: tag });
      const balances: Record<string, { supply: bigint; holders: Record<string, bigint> }> = {};
      const allowances: Record<string, bigint[]> = {};
      for (const [name, token] of [["usd", usd], ["yes", yes]] as const) {
        const holders: Record<string, bigint> = {};
        for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
          holders[role] = await read(token, "balanceOf", address);
        }
        const supply: bigint = await read(token, "totalSupply");
        assert.equal(Object.values(holders).reduce((sum, amount) => sum + amount, 0n), supply);
        balances[name] = { supply, holders };
        allowances[name] = await Promise.all([
          [evm.roles.executor, evm.contracts.settlement], [evm.contracts.settlement, evm.contracts.venue],
          [evm.contracts.venue, evm.contracts.settlement], [evm.contracts.settlement, evm.roles.executor],
        ].map(([owner, spender]) => read(token, "allowance", owner, spender)));
      }
      assert.deepEqual(balances, {
        usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 90_000_000n, venue: 10_000_000n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 180_000_000n, settlement: 20_000_000n } },
      });
      assert.deepEqual(allowances, { usd: [90_000_000n, 0n, 0n, 0n], yes: [0n, 0n, 0n, 0n] });
      const counters = { cash: await read(settlement, "totalCashSpent"), shares: await read(settlement, "totalSharesPurchased") };
      assert.deepEqual(counters, { cash: 10_000_000n, shares: 20_000_000n });
      const record = await read(settlement, "orderRecord", orderId);
      assert.equal(record.status, 1n); assert.equal(record.termsHash, termsHash); assert.equal(record.receiptHash, receiptHash);
      assert.equal(record.filledQuantity, 20_000_000n);
      assert.equal(settlement.interface.encodeFunctionData("execute", [orderId, record.terms]),
        settlement.interface.encodeFunctionData("execute", [orderId, terms]));
      const logs = await provider.send("eth_getLogs", [{ address: Object.values(evm.contracts), fromBlock: "0x0", toBlock: tag }]);
      const terminal = logs.filter((log: { address: string; topics: string[] }) => log.address.toLowerCase() === evm.contracts.settlement.toLowerCase()
        && log.topics[0] === settlement.interface.getEvent("TerminalRecorded")!.topicHash);
      assert.equal(terminal.length, 1, "Exactly one terminal record exists in this fixture");
      assert.equal(terminal[0].topics[1], orderId); assert.equal(terminal[0].transactionHash, originalHash);
      assert.deepEqual(Array.from(settlement.interface.parseLog(terminal[0])!.args), [orderId, termsHash, 1n, 20_000_000n, receiptHash]);
      const native = [];
      for (const address of new Set([...Object.values(evm.roles), ...Object.values(evm.contracts)])) {
        native.push({ address, balance: await provider.send("eth_getBalance", [address, tag]),
          nonce: await provider.send("eth_getTransactionCount", [address, tag]), pendingNonce: await provider.send("eth_getTransactionCount", [address, "pending"]) });
      }
      return { head: { number: BigInt(at.number), hash: at.hash }, balances, allowances, counters,
        record: settlement.interface.encodeFunctionResult("orderRecord", [record]), logs, native };
    }
    const snapshot = async () => ({ source: await sourceSnapshot(), destination: await destinationSnapshot() });
    async function runWorker(attempt: Attempt) {
      const child = spawn(process.execPath, [join(root, "harness/src/recovery-observation-worker.ts")], {
        cwd: root, env: { DUAL_CHAIN_SETUP_RUNTIME: runtime }, stdio: ["pipe", "pipe", "pipe"], detached: false,
      });
      children.add(child); attempt.processId = child.pid;
      let stdout = "", stderr = "", executionFailure: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: string) => {
        executionFailure ??= reason; child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      };
      const timeout = setTimeout(() => stop("Worker exceeded 150-second execution bound"), 150_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) stop("Worker stdout exceeded public evidence budget");
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 64 * 1024) stop("Worker stderr exceeded public error budget");
      });
      child.stdin!.on("error", (error) => stop(`Worker stdin failed: ${error.message}`));
      const completed = new Promise<void>((done) => {
        child.on("error", (error) => { executionFailure ??= error.message; });
        child.once("close", (code, signal) => {
          clearTimeout(timeout); clearTimeout(killTimer); children.delete(child);
          attempt.exitCode = code; attempt.signal = signal; attempt.stdout = stdout; attempt.stderr = stderr;
          if (executionFailure) attempt.failure = executionFailure;
          persist(); done();
        });
      });
      child.stdin!.end(serialize(attempt.stdin) + "\n");
      await completed;
      assert.equal(executionFailure, undefined); assert.equal(attempt.signal, null); assert.equal(attempt.exitCode, 0);
      assert.equal(stdout.trim().split("\n").length, 1, "Worker emits exactly one JSON object");
      const output = JSON.parse(stdout) as WorkerOutput;
      assert.deepEqual(Object.keys(output).sort(), ["observation", "processId", "recoveryReads"]);
      assert.equal(output.processId, attempt.processId); assert.notEqual(output.processId, process.pid);
      attempt.output = output; persist();
      return output;
    }
    function assertSource(output: WorkerOutput) {
      assert.deepEqual(output.observation.source, { accounts, contextSlot: output.observation.source.contextSlot, state: "Pending",
        cancellationRequested: false, acceptedReceipt: null, orderId, termsHash, escrowBalance: "10000000", terms });
      assert.ok(output.observation.source.contextSlot >= creationSlot);
      const reads = output.recoveryReads;
      assert.equal(reads.source.length, 1);
      assert.deepEqual(reads.source[0].params, [[config, userNonce, order, escrow].map((key) => key.toBase58()),
        { encoding: "base64", commitment: "finalized", minContextSlot: creationSlot }]);
      assert.equal(reads.source[0].method, "getMultipleAccounts");
      const sourceResponse = reads.source[0].response as { result: { context: { slot: number }; value: unknown[] } };
      assert.equal(sourceResponse.result.value.length, 4);
      assert.equal(sourceResponse.result.context.slot, output.observation.source.contextSlot);
      assert.ok(reads.configurationVerification.reads.length > 0);
      assert.ok(reads.configurationVerification.observation.solana.contextSlot >= creationSlot);
      assert.equal(reads.configurationVerification.reads.filter((read) => read.chain === "Solana").length, 1);
      assert.equal(reads.destination.filter((read) => read.method === "eth_getLogs").length, 1);
      assert.ok(reads.destination.every((read) => ["eth_chainId", "eth_getLogs", "eth_getTransactionReceipt",
        "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"].includes(read.method)));
    }
    function assertFilled(output: WorkerOutput) {
      assertSource(output);
      const destination = output.observation.destination;
      assert.equal(destination.kind, "Observed"); if (destination.kind !== "Observed") assert.fail();
      assert.equal(destination.transactionHash, originalHash); assert.notEqual(destination.transactionHash, replayHash);
      assert.deepEqual(destination.observation, { kind: "Confirmed", orderId, termsHash, terms, receipt: canonicalReceipt, receiptHash,
        transactionHash: originalHash, inclusion: { number: originalBlock.toString(), hash: original.blockHash },
        observationHead: { number: toBlock.toString(), hash: head.hash }, additionalBlocks: (toBlock - originalBlock).toString() });
      assert.deepEqual(output.observation.plan, { kind: "DeliverFilled", orderId, termsHash, receiptHash });
      const logs = output.recoveryReads.destination.find((read) => read.method === "eth_getLogs")!;
      assert.deepEqual(logs.params, [{ address: evm.contracts.settlement.toLowerCase(),
        topics: [settlement.interface.getEvent("TerminalRecorded")!.topicHash, orderId], fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock) }]);
      assert.equal((logs.response as { transactionHash: string }[]).length, 1);
      assert.equal((logs.response as { transactionHash: string }[])[0].transactionHash, originalHash);
      const receipts = output.recoveryReads.destination.filter((read) => read.method === "eth_getTransactionReceipt");
      // Discovery binds the candidate event; the observer reads and rechecks its receipt.
      assert.equal(receipts.length, 3);
      for (const read of receipts) {
        assert.deepEqual(read.params, [originalHash]); assert.deepEqual(read.response, original);
      }
      const transactions = output.recoveryReads.destination.filter((read) => read.method === "eth_getTransactionByHash");
      assert.equal(transactions.length, 1); assert.deepEqual(transactions[0].params, [originalHash]);
      const storageReads = output.recoveryReads.destination.filter((read) => read.method === "eth_call");
      assert.equal(storageReads.length, 6);
      for (const [index, blockHash] of [original.blockHash, head.hash].entries()) {
        assert.deepEqual(storageReads.slice(index * 3, index * 3 + 3).map((read) => read.params),
          ["domain", "operator", "orderRecord"].map((name) => [{ to: evm.contracts.settlement.toLowerCase(),
            data: settlement.interface.encodeFunctionData(name, name === "orderRecord" ? [orderId] : []) }, { blockHash, requireCanonical: true }]));
      }
    }
    async function attempt(label: string, stdin: WorkerInput, verify: (output: WorkerOutput) => void) {
      const record: Attempt = { label, stdin: structuredClone(stdin), parentProcessId: process.pid };
      evidence.attempts.push(record);
      const before = await snapshot(); record.before = before; persist();
      try { const output = await runWorker(record); verify(output); return output; }
      catch (error) { record.failure = error instanceof Error ? error.message : String(error); throw error; }
      finally {
        const after = await snapshot(); record.after = after; persist();
        assert.deepEqual(after.source.state, before.source.state, "Source state/activity unchanged, excluding context slots");
        assert.deepEqual(after.destination, before.destination, "Destination head, history, terminal storage and economics unchanged");
        record.unchanged = true; persist();
      }
    }
    let workerAPid = 0;
    await check("worker A recovers genuine Pending and original Confirmed Filled after eventless replay", async () => {
      const output = await attempt("worker A", input, assertFilled); workerAPid = output.processId;
    });
    await check("worker B independently reconstructs the same receipt in another fresh process", async () => {
      // Only the same original public input is supplied; A's output is never an input.
      await attempt("worker B", input, (output) => { assert.notEqual(output.processId, workerAPid); assertFilled(output); });
    });
    await check("eventless replay-only range returns NotFound and Wait while storage stays Filled", async () => {
      assert.ok(replayBlock > originalBlock);
      await attempt("replay-only worker", { ...input, fromBlock: replayBlock.toString(), toBlock: replayBlock.toString() }, (output) => {
        assert.notEqual(output.processId, workerAPid);
        assert.notEqual(output.processId, evidence.attempts[1].processId);
        assertSource(output);
        assert.deepEqual(output.observation.destination, { kind: "NotFound", searched: { fromBlock: replayBlock.toString(), toBlock: replayBlock.toString() } });
        assert.deepEqual(output.observation.plan, { kind: "Wait", reason: "DestinationNotObserved", orderId, termsHash });
        const reads = output.recoveryReads.destination;
        assert.deepEqual(reads.map((read) => read.method), ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getBlockByNumber"]);
        assert.deepEqual(reads[2].response, []);
        assert.deepEqual(reads[2].params, [{ address: evm.contracts.settlement.toLowerCase(),
          topics: [settlement.interface.getEvent("TerminalRecorded")!.topicHash, orderId], fromBlock: toQuantity(replayBlock), toBlock: toQuantity(replayBlock) }]);
      });
      const record = await settlement.getFunction("orderRecord").staticCall(orderId);
      assert.equal(record.status, 1n); assert.equal(record.receiptHash, receiptHash);
      evidence.stages.boundedAbsence = { storageStatus: "Filled", receiptHash, recoveryResends: 0, receiptDeliveries: 0,
        boundedAbsenceEstablishesUnseen: false, resendAuthorized: false };
    });
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); persist(); throw error; }
  finally {
    // Children inherit the runner-owned group. Never detach or signal an unrelated group.
    await Promise.all([...children].map(async (child) => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await new Promise<void>((done) => child.once("close", () => done())); }
      finally { clearTimeout(timer); children.delete(child); }
    }));
    evidence.childrenStopped = children.size === 0; provider.destroy(); persist();
  }
});
