import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { WorkerInput, WorkerOutput } from "../cancelled-recovery-worker.ts";

const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-cancelled-recovery.sh after unchanged setup and forwarding suites");
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
// Preserve every unsafe integer token before JSON.parse can round it. Strings
// (including encoded accounts/logs) are consumed whole and are never rewritten.
function exactJson(text: string): unknown {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return `"${token}"`;
    return token;
  }));
}
function integer(value: unknown): bigint {
  if (typeof value === "number") { assert.ok(Number.isSafeInteger(value) && value >= 0); return BigInt(value); }
  assert.ok(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)); return BigInt(value);
}
type ExactInfo = Omit<AccountInfo<Buffer>, "lamports" | "rentEpoch"> & { lamports: bigint; rentEpoch: bigint };
type RpcAccount = { owner: string; executable: boolean; lamports: unknown; rentEpoch: unknown; data: [string, string] };
function decodeRpcAccount(value: RpcAccount | null): ExactInfo | null {
  return value && { owner: new PublicKey(value.owner), executable: value.executable, lamports: integer(value.lamports),
    rentEpoch: integer(value.rentEpoch), data: Buffer.from(value.data[0], "base64") };
}
function splInfo(value: ExactInfo): AccountInfo<Buffer> {
  assert.ok(value.lamports <= BigInt(Number.MAX_SAFE_INTEGER));
  return { ...value, lamports: Number(value.lamports), rentEpoch: undefined };
}
function publicAccount(key: PublicKey, value: ExactInfo | null) {
  return { address: key.toBase58(), account: value && { owner: value.owner.toBase58(), executable: value.executable,
    lamports: value.lamports, rentEpoch: value.rentEpoch, space: value.data.length, dataHex: value.data.toString("hex") } };
}
function decodedValue(value: unknown): unknown {
  if (anchor.BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(decodedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodedValue(v)]));
  return value;
}
function credential(name: "initializer") {
  const directory = join(runtime, "credentials"), path = join(directory, `${name}.json`);
  assert.equal(realpathSync(runtime), runtime); assert.equal(realpathSync(directory), directory); assert.equal(realpathSync(path), path);
  assert.equal(statSync(directory).mode & 0o777, 0o700); assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const { Program, EventParser } = anchor;
type ForwardingEvidence = { checks: string[]; failure?: unknown; stages: {
  selectedInputs: { user: string; nonce: string; cashAmount: string; minimumShares: string };
  creation: { finalizedSlot: number };
  cancellation: { finalizedSlot: number };
  forwarding: { submission: { transactionHash: string } };
  replay: { submission: { transactionHash: string } };
} };
type Attempt = { label: string; stdin: WorkerInput; parentProcessId: number; processId?: number;
  exitCode?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string;
  output?: WorkerOutput; before?: unknown; after?: unknown; unchanged?: boolean; failure?: string };

test("fresh processes resume Cancelled after cancellation and stop after completed refund", { timeout: 550_000 }, async (t) => {
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const forwarding = json("cancellation-forwarding-live-evidence.json") as ForwardingEvidence;
  const evidence: { scope: string; limitations: string[]; checks: string[]; stages: Record<string, unknown>;
    attempts: Attempt[]; childrenStopped?: boolean; failure?: string } = {
    scope: "Fresh application-process recovery and one resumed Cancelled refund, followed by Complete without submission while both nodes stay running.",
    limitations: ["Trusted RPC/operator and local finalized Solana / EVM N+2 observations; no production finality or trustless bridge.",
      "No machine/node restart, broadcast-crash recovery, concurrent workers, Filled delivery, queue or automatic retry.",
      "The unchanged forwarding fixture contains an explicit eventless EVM replay; recovery sends no EVM writes.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation remains."],
    checks: [], stages: {}, attempts: [],
  };
  const persist = () => writeFileSync(join(runtime, "cancelled-recovery-live-evidence.json"), JSON.stringify(evidence,
    (_, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2) + "\n");
  const children = new Set<ChildProcess>();
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      assert.ok(["getLatestBlockhash", "sendTransaction", "getSignatureStatuses"].includes(call.method));
      if (call.method === "sendTransaction") { assert.equal(call.params[1].maxRetries, 0); assert.equal(call.params[1].preflightCommitment, "finalized"); }
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  const send = provider.send.bind(provider);
  provider.send = (method: string, params: unknown[] | Record<string, unknown>) => {
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getLogs", "eth_getTransactionReceipt",
      "eth_getTransactionByHash", "eth_getBalance", "eth_getTransactionCount"].includes(method), `Forbidden parent RPC: ${method}`);
    return send(method, params);
  };
  let rpcId = 0;
  async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
    assert.ok(["getMultipleAccounts", "getProgramAccounts", "getSignaturesForAddress", "getTransaction"].includes(method));
    const response = await fetch("http://127.0.0.1:18899", { method: "POST", headers: { "content-type": "application/json" },
      body: serialize({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(10_000) });
    assert.ok(response.ok);
    const parsed = exactJson(await response.text()) as { error?: unknown; result: T };
    assert.equal(parsed.error, undefined); return parsed.result;
  }
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
    const creationSlot = forwarding.stages.cancellation.finalizedSlot;
    assert.ok(creationSlot > forwarding.stages.creation.finalizedSlot);
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
    const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), raw(termsHash), Buffer.from([2]), uint(0n, 8)]);
    assert.equal(receiptPreimage.length, 49);
    const receiptHash = sha(receiptPreimage);
    const terms = publicValue({ identity: { domain: { sourceDomain: evm.sourceDomain.toLowerCase(), destinationDomain: evm.destinationDomain.toLowerCase(),
      solanaProgram: hex(programId.toBytes()), chainId: evm.chainId, settlement: evm.contracts.settlement.toLowerCase() },
      user: hex(user.toBytes()), nonce: selected.nonce }, market: evm.market.toLowerCase(), outcome: 0,
      cashAmount: selected.cashAmount, minimumShares: selected.minimumShares });
    const canonicalReceipt = { termsHash, terminal: 2, filledQuantity: "0" };
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
    const originalHash = forwarding.stages.forwarding.submission.transactionHash, replayHash = forwarding.stages.replay.submission.transactionHash;
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

    const program = new Program<SettlementLab>(JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")), { connection });
    assert.ok(program.programId.equals(programId));
    const parser = new EventParser(programId, program.coder);
    let minimumSlot = creationSlot;
    async function sourceSnapshot() {
      const options = { commitment: "finalized", minContextSlot: minimumSlot, encoding: "base64" };
      const rpc = await solanaRpc<{ context: { slot: number }; value: (RpcAccount | null)[] }>("getMultipleAccounts", [keys.map((key) => key.toBase58()), options]);
      const response = { context: rpc.context, value: rpc.value.map(decodeRpcAccount) };
      assert.ok(response.context.slot >= minimumSlot);
      const protocolRpc = await solanaRpc<{ context: { slot: number }; value: { pubkey: string; account: RpcAccount }[] }>("getProgramAccounts", [programId.toBase58(), { ...options, minContextSlot: response.context.slot, withContext: true }]);
      const protocol = { context: protocolRpc.context, value: protocolRpc.value.map((item) => ({ pubkey: new PublicKey(item.pubkey), account: decodeRpcAccount(item.account)! })) };
      assert.ok(protocol.context.slot >= response.context.slot); assert.equal(protocol.value.length, 4);
      const activity = (await solanaRpc<{ signature: string; slot: number; err: unknown; confirmationStatus: string }[]>("getSignaturesForAddress", [programId.toBase58(), { limit: 100, commitment: "finalized" }]))
        .map(({ signature, slot, err, confirmationStatus }) => ({ signature, slot, err, confirmationStatus }));
      assert.ok(activity.length < 100, "Activity snapshot must not be truncated");
      const tokens = [];
      for (const mint of [cashMint, yesMint]) {
        const info = response.value[keys.findIndex((key) => key.equals(mint))]; assert.ok(info);
        const supply = unpackMint(mint, splInfo(info), TOKEN_PROGRAM_ID).supply;
        const holdersRpc = await solanaRpc<{ pubkey: string; account: RpcAccount }[]>("getProgramAccounts", [TOKEN_PROGRAM_ID.toBase58(), { ...options, minContextSlot: response.context.slot,
          filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] }]);
        const holders = holdersRpc.map((item) => ({ pubkey: new PublicKey(item.pubkey), account: decodeRpcAccount(item.account)! }));
        const balances = holders.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), amount: unpackAccount(pubkey, splInfo(account), TOKEN_PROGRAM_ID).amount }))
          .sort((a, b) => a.address.localeCompare(b.address));
        assert.equal(balances.reduce((sum, holder) => sum + holder.amount, 0n), supply);
        tokens.push({ mint: mint.toBase58(), supply, balances,
          accounts: holders.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)) });
      }
      function token(index: number) { const info = response.value[index]; assert.ok(info); return unpackAccount(keys[index], splInfo(info), TOKEN_PROGRAM_ID).amount; }
      const accounting = response.value[1]; assert.ok(accounting);
      const counters = Array.from({ length: 4 }, (_, i) => accounting.data.readBigUInt64LE(40 + i * 16)
        + (accounting.data.readBigUInt64LE(48 + i * 16) << 64n));
      const economics = { userCash: token(8), escrow: token(4), cashSupply: tokens[0].supply, userYes: token(9), yesSupply: tokens[1].supply,
        executorCash: token(7), counters };
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
        usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 100_000_000n, venue: 0n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 200_000_000n, settlement: 0n } },
      });
      assert.deepEqual(allowances, { usd: [100_000_000n, 0n, 0n, 0n], yes: [0n, 0n, 0n, 0n] });
      const counters = { cash: await read(settlement, "totalCashSpent"), shares: await read(settlement, "totalSharesPurchased") };
      assert.deepEqual(counters, { cash: 0n, shares: 0n });
      const record = await read(settlement, "orderRecord", orderId);
      assert.equal(record.status, 2n); assert.equal(record.termsHash, termsHash); assert.equal(record.receiptHash, receiptHash);
      assert.equal(record.filledQuantity, 0n);
      assert.equal(settlement.interface.encodeFunctionData("execute", [orderId, record.terms]),
        settlement.interface.encodeFunctionData("execute", [orderId, terms]));
      const logs = await provider.send("eth_getLogs", [{ address: Object.values(evm.contracts), fromBlock: "0x0", toBlock: tag }]);
      const terminal = logs.filter((log: { address: string; topics: string[] }) => log.address.toLowerCase() === evm.contracts.settlement.toLowerCase()
        && log.topics[0] === settlement.interface.getEvent("TerminalRecorded")!.topicHash);
      assert.equal(terminal.length, 1, "Exactly one terminal record exists in this fixture");
      assert.equal(terminal[0].topics[1], orderId); assert.equal(terminal[0].transactionHash, originalHash);
      assert.deepEqual(Array.from(settlement.interface.parseLog(terminal[0])!.args), [orderId, termsHash, 2n, 0n, receiptHash]);
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
      const child = spawn(process.execPath, [join(root, "harness/src/cancelled-recovery-worker.ts")], {
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
        if (Buffer.byteLength(stdout) + chunk.length > 8 * 1024 * 1024) stop("Worker stdout exceeded public evidence budget");
        else if (!executionFailure) stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) + chunk.length > 64 * 1024) stop("Worker stderr exceeded public error budget");
        else if (!executionFailure) stderr += chunk.toString();
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
      assert.deepEqual(Object.keys(output).sort(), ["credentialReads", "delivery", "deliveryReads", "observation", "processId", "recoveryReads", "signingCount", "submissionCount"]);
      assert.equal(output.processId, attempt.processId); assert.notEqual(output.processId, process.pid);
      attempt.output = output; persist();
      return output;
    }
    function assertSource(output: WorkerOutput, refunded = false) {
      assert.deepEqual(output.observation.source, { accounts, contextSlot: output.observation.source.contextSlot, state: refunded ? "Refunded" : "CancelRequested",
        cancellationRequested: true, acceptedReceipt: refunded ? { terminal: 2, filledQuantity: "0", receiptHash } : null, orderId, termsHash, escrowBalance: refunded ? "0" : "10000000", terms });
      assert.ok(output.observation.source.contextSlot >= input.minFinalizedSlot);
      const reads = output.recoveryReads;
      assert.equal(reads.source.length, 1);
      assert.deepEqual(reads.source[0].params, [[config, userNonce, order, escrow].map((key) => key.toBase58()),
        { encoding: "base64", commitment: "finalized", minContextSlot: input.minFinalizedSlot }]);
      assert.equal(reads.source[0].method, "getMultipleAccounts");
      const sourceResponse = reads.source[0].response as { result: { context: { slot: number }; value: unknown[] } };
      assert.equal(sourceResponse.result.value.length, 4);
      assert.equal(sourceResponse.result.context.slot, output.observation.source.contextSlot);
      assert.ok(reads.configurationVerification.reads.length > 0);
      assert.ok(reads.configurationVerification.observation.solana.contextSlot >= input.minFinalizedSlot);
      assert.equal(reads.configurationVerification.reads.filter((read) => read.chain === "Solana").length, 1);
      assert.equal(reads.destination.filter((read) => read.method === "eth_getLogs").length, 1);
      assert.ok(reads.destination.every((read) => ["eth_chainId", "eth_getLogs", "eth_getTransactionReceipt",
        "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"].includes(read.method)));
    }
    function assertCancelled(output: WorkerOutput, refunded = false) {
      assertSource(output, refunded);
      const destination = output.observation.destination;
      assert.equal(destination.kind, "Observed"); if (destination.kind !== "Observed") assert.fail();
      assert.equal(destination.transactionHash, originalHash); assert.notEqual(destination.transactionHash, replayHash);
      assert.deepEqual(destination.observation, { kind: "Confirmed", orderId, termsHash, terms, receipt: canonicalReceipt, receiptHash,
        transactionHash: originalHash, inclusion: { number: originalBlock.toString(), hash: original.blockHash },
        observationHead: { number: toBlock.toString(), hash: head.hash }, additionalBlocks: (toBlock - originalBlock).toString() });
      assert.deepEqual(output.observation.plan, refunded ? { kind: "Complete", sourceState: "Refunded", orderId, termsHash, receiptHash } : { kind: "DeliverCancelled", orderId, termsHash, receiptHash });
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
    async function attempt(label: string, stdin: WorkerInput, verify: (output: WorkerOutput) => Promise<void> | void, readOnly = true) {
      const record: Attempt = { label, stdin: structuredClone(stdin), parentProcessId: process.pid };
      evidence.attempts.push(record);
      const before = await snapshot(); record.before = before; persist();
      try { const output = await runWorker(record); await verify(output); return output; }
      catch (error) { record.failure = error instanceof Error ? error.message : String(error); throw error; }
      finally {
        const after = await snapshot(); record.after = after; persist();
        if (readOnly) assert.deepEqual(after.source.state, before.source.state, "Source state/activity unchanged, excluding context slots");
        assert.deepEqual(after.destination, before.destination, "Destination head, history, terminal storage and economics unchanged");
        record.unchanged = readOnly; persist();
      }
    }
    type Snapshot = Awaited<ReturnType<typeof sourceSnapshot>>;
    type TxRecord = { slot: number; transaction: { signatures: string[]; message: { accountKeys: string[]; header: { numRequiredSignatures: number }; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
      meta: { err: unknown; fee: unknown; preBalances: unknown[]; postBalances: unknown[]; logMessages: string[];
        innerInstructions: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] } };
    async function transactionRecord(signature: string) {
      const record = await solanaRpc<TxRecord | null>("getTransaction", [signature, { commitment: "finalized", maxSupportedTransactionVersion: 0, encoding: "json" }]);
      assert.ok(record?.meta); assert.equal(record.meta.err, null); assert.equal(record.transaction.signatures[0], signature);
      const message = record.transaction.message;
      const decode = (ix: { programIdIndex: number; accounts: number[]; data: string }) => ({ program: message.accountKeys[ix.programIdIndex],
        accounts: ix.accounts.map((index) => message.accountKeys[index]), dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex") });
      return { signature, finalizedSlot: record.slot, fee: integer(record.meta.fee),
        requiredSigners: message.accountKeys.slice(0, message.header.numRequiredSignatures),
        instructions: message.instructions.map(decode),
        inner: (record.meta.innerInstructions ?? []).flatMap((group) => group.instructions.map((ix) => ({ parentIndex: group.index, ...decode(ix) }))),
        events: decodedValue([...parser.parseLogs(record.meta.logMessages ?? [])]),
        balances: message.accountKeys.map((address, index) => ({ address, before: integer(record.meta.preBalances[index]), after: integer(record.meta.postBalances[index]) })),
        record };
    }
    async function submitFixture(instruction: TransactionInstruction, payer: Keypair) {
      const block = await connection.getLatestBlockhash({ commitment: "finalized", minContextSlot: minimumSlot });
      const tx = new Transaction({ ...block, feePayer: payer.publicKey }).add(instruction); tx.sign(payer);
      const signature = anchor.utils.bytes.bs58.encode(tx.signature!);
      try {
        assert.equal(await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "finalized", maxRetries: 0 }), signature);
        const deadline = Date.now() + 60_000;
        for (let polls = 0; polls < 300 && Date.now() < deadline; polls++) {
          const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
          if (status?.err) throw new Error("Fixture transaction failed");
          if (status?.confirmationStatus === "finalized") {
            const record = await transactionRecord(signature); assert.equal(record.finalizedSlot, status.slot);
            minimumSlot = Math.max(minimumSlot, record.finalizedSlot); return record;
          }
          await new Promise((done) => setTimeout(done, 200));
        }
        throw new Error("Fixture finalization deadline exceeded; execution outcome may be unknown");
      } catch (error) { throw new Error(`Fixture failed, public signature ${signature}`, { cause: error }); }
    }
    function account(snapshot: Snapshot, key: PublicKey) {
      const found = snapshot.state.accounts.find((item) => item.address === key.toBase58()); assert.ok(found); return found;
    }
    function orderDecoded(snapshot: Snapshot) { return decodedValue(program.coder.accounts.decode("order", Buffer.from(account(snapshot, order).account!.dataHex, "hex"))) as Record<string, unknown>; }
    const lockedEconomics = { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
      userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] };
    const operatorKey = new PublicKey(source.roles.operator), initializerKey = new PublicKey(source.roles.initializer);
    const destinationBefore = await destinationSnapshot();
    await check("reuse the existing finalized cancellation request with locked escrow and unchanged Accounting", async () => {
      const before = await sourceSnapshot(); assert.deepEqual(before.state.economics, lockedEconomics);
      const decoded = orderDecoded(before);
      assert.deepEqual(decoded.state, { cancelRequested: {} });
      assert.equal(decoded.cancellationRequested, true); assert.equal(decoded.acceptedReceipt, null);
      evidence.stages.originalCancellationRequest = { finalizedSlot: creationSlot, source: before };
    });
    await check("initializer finalizes only small operator fee funding with exact integer native balances", async () => {
      const before = await sourceSnapshot(); assert.equal(account(before, operatorKey).account, null);
      const initializer = credential("initializer"); assert.ok(initializer.publicKey.equals(initializerKey));
      const funding = await submitFixture(SystemProgram.transfer({ fromPubkey: initializerKey, toPubkey: operatorKey, lamports: 2_000_000n }), initializer);
      assert.deepEqual(funding.requiredSigners, [initializerKey.toBase58()]); assert.deepEqual(funding.inner, []); assert.deepEqual(funding.events, []);
      const after = await sourceSnapshot(); const expected = structuredClone(before.state);
      const funded = expected.accounts.find((item) => item.address === operatorKey.toBase58())!;
      funded.account = { owner: SystemProgram.programId.toBase58(), executable: false, lamports: 2_000_000n,
        rentEpoch: account(after, operatorKey).account!.rentEpoch, space: 0, dataHex: "" };
      expected.accounts.find((item) => item.address === initializerKey.toBase58())!.account!.lamports -= 2_000_000n + funding.fee;
      assert.deepEqual(after.state, expected);
      const payer = funding.balances.find((item) => item.address === initializerKey.toBase58())!;
      assert.equal(payer.before, account(before, initializerKey).account!.lamports);
      assert.equal(payer.after, payer.before - 2_000_000n - funding.fee);
      assert.ok(payer.before > BigInt(Number.MAX_SAFE_INTEGER), "Exercise lossless genesis balance parsing");
      const decoded = orderDecoded(after); assert.deepEqual(decoded.state, { cancelRequested: {} });
      assert.equal(decoded.cancellationRequested, true); assert.equal(decoded.acceptedReceipt, null);
      assert.deepEqual(after.state.economics, lockedEconomics); assert.deepEqual(await destinationSnapshot(), destinationBefore);
      evidence.stages.feeFunding = { ...funding, fundedLamports: 2_000_000n, before, after };
    });
    // Public input uses the finalized fixture bound; no accept_cancelled instruction
    // has been constructed or retained in the parent.
    input.minFinalizedSlot = minimumSlot;
    function noSubmission(output: WorkerOutput) {
      assert.equal(output.submissionCount, 0); assert.equal(output.credentialReads, 0); assert.equal(output.signingCount, 0);
      assert.deepEqual(output.deliveryReads, []); assert.equal(output.delivery, null);
    }
    await check("worker A replay-only range independently returns NotFound and Wait with no credentials, fees or writes", async () => {
      await attempt("A: replay-only Wait", { ...input, fromBlock: replayBlock.toString(), toBlock: replayBlock.toString() }, (output) => {
        assertSource(output); noSubmission(output);
        assert.deepEqual(output.observation.destination, { kind: "NotFound", searched: { fromBlock: replayBlock.toString(), toBlock: replayBlock.toString() } });
        assert.deepEqual(output.observation.plan, { kind: "Wait", reason: "DestinationNotObserved", orderId, termsHash });
        const reads = output.recoveryReads.destination;
        assert.deepEqual(reads.map((read) => read.method), ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getBlockByNumber"]);
        assert.deepEqual(reads[2].response, []);
        assert.deepEqual(reads[2].params, [{ address: evm.contracts.settlement.toLowerCase(),
          topics: [settlement.interface.getEvent("TerminalRecorded")!.topicHash, orderId], fromBlock: toQuantity(replayBlock), toBlock: toQuantity(replayBlock) }]);
      });
    });
    await check("worker B independently rediscovers original Cancelled and finalizes exactly one accept_cancelled refund with exact SPL effects", async () => {
      const before = await sourceSnapshot();
      await attempt("B: resumed Cancelled refund", input, async (output) => {
        assertCancelled(output); assert.notEqual(output.processId, evidence.attempts[0].processId);
        assert.equal(output.submissionCount, 1); assert.equal(output.credentialReads, 1); assert.equal(output.signingCount, 1);
        assert.ok(output.delivery); const delivery = await transactionRecord(output.delivery.signature);
        assert.equal(output.delivery.finalizedSlot, delivery.finalizedSlot); assert.equal(output.delivery.fee, delivery.fee.toString());
        minimumSlot = Math.max(minimumSlot, delivery.finalizedSlot);
        assert.deepEqual(delivery.requiredSigners, [operatorKey.toBase58()]);
        const d = Buffer.concat([raw(evm.sourceDomain), raw(evm.destinationDomain), programId.toBuffer(), uint(BigInt(evm.chainId), 32), raw(evm.contracts.settlement)]);
        const expectedData = Buffer.concat([raw(sha(Buffer.from("global:accept_cancelled"))).subarray(0, 8), d, user.toBuffer(), uint(nonce, 8).reverse(),
          raw(evm.market), Buffer.from([0]), uint(10_000_000n, 8).reverse(), uint(20_000_000n, 8).reverse(), raw(termsHash), Buffer.from([2]), uint(0n, 8).reverse()]);
        const instructionAccounts = [operatorKey, user, config, new PublicKey(source.accounts.accounting), userNonce, order, cashMint, userCash, escrow, TOKEN_PROGRAM_ID];
        assert.deepEqual(delivery.instructions, [{ program: programId.toBase58(), accounts: instructionAccounts.map((key) => key.toBase58()), dataHex: expectedData.toString("hex") }]);
        const decoded = new anchor.BorshInstructionCoder(program.idl).decode(expectedData); assert.ok(decoded); assert.equal(decoded.name, "acceptCancelled");
        assert.deepEqual(decodedValue(decoded.data), { args: { terms: { domain: { sourceDomain: [...raw(evm.sourceDomain)], destinationDomain: [...raw(evm.destinationDomain)],
          solanaProgram: programId.toBase58(), chainId: [...uint(BigInt(evm.chainId), 32)], settlement: [...raw(evm.contracts.settlement)] },
          user: user.toBase58(), nonce: selected.nonce, market: [...raw(evm.market)], outcome: 0, cashAmount: "10000000", minimumShares: "20000000" },
          receipt: { termsHash: [...raw(termsHash)], terminal: 2, filledQuantity: "0" } } });
        assert.deepEqual(delivery.events, [{ name: "cancelledAccepted", data: { order: order.toBase58(), termsHash: [...raw(termsHash)],
          receiptHash: [...raw(receiptHash)], cashAmount: "10000000" } }]);
        assert.deepEqual(delivery.inner, [
          { parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(), accounts: [escrow, cashMint, userCash, order].map((key) => key.toBase58()),
            dataHex: Buffer.concat([Buffer.from([12]), uint(10_000_000n, 8).reverse(), Buffer.from([6])]).toString("hex") } ]);
        assert.deepEqual(delivery.record.meta.logMessages.filter((line) => /^Program .* invoke/.test(line)),
          [`Program ${programId.toBase58()} invoke [1]`, `Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`]);
        const sends = output.deliveryReads.filter((read) => read.method === "sendTransaction"); assert.equal(sends.length, 1);
        assert.ok(output.deliveryReads.every((read) => read.chain === "Solana" && ["getLatestBlockhash", "sendTransaction", "getSignatureStatuses", "getTransaction", "getMultipleAccounts"].includes(read.method)));
        const sendParams = sends[0].params as [string, { maxRetries: number; preflightCommitment: string }];
        assert.equal(sendParams[1].maxRetries, 0); assert.equal(sendParams[1].preflightCommitment, "finalized");
        const submitted = Transaction.from(Buffer.from(sendParams[0], "base64"));
        assert.equal(anchor.utils.bytes.bs58.encode(submitted.signature!), delivery.signature);
        assert.equal(submitted.feePayer?.toBase58(), operatorKey.toBase58()); assert.equal(submitted.instructions.length, 1);
        assert.deepEqual(submitted.instructions[0].data, expectedData);
        assert.deepEqual(submitted.instructions[0].keys, instructionAccounts.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index === 0 || [3, 5, 7, 8].includes(index) })));
        const after = await sourceSnapshot();
        assert.deepEqual(after.state.economics, { userCash: 25_000_000n, escrow: 0n, executorCash: 0n, cashSupply: 25_000_000n,
          userYes: 0n, yesSupply: 0n, counters: [10_000_000n, 10_000_000n, 0n, 0n] });
        assert.deepEqual(orderDecoded(after), { ...orderDecoded(before), state: { refunded: {} }, cancellationRequested: true,
          acceptedReceipt: { terminal: 2, filledQuantity: "0", receiptHash: [...raw(receiptHash)] } });
        const expected = structuredClone(before.state);
        const expectedAccount = (key: PublicKey) => expected.accounts.find((item) => item.address === key.toBase58())!.account!;
        const orderBefore = Buffer.from(expectedAccount(order).dataHex, "hex");
        const terminalBytes = Buffer.concat([orderBefore.subarray(0, 289), Buffer.from([3, 1, 1, 2]), uint(0n, 8).reverse(), raw(receiptHash), orderBefore.subarray(292, 294)]);
        assert.equal(terminalBytes.length, 335); expectedAccount(order).dataHex = terminalBytes.toString("hex");
        expectedAccount(new PublicKey(source.accounts.accounting)).dataHex = Buffer.concat([raw(sha(Buffer.from("account:Accounting"))).subarray(0, 8), config.toBuffer(),
          ...[10_000_000n, 10_000_000n, 0n, 0n].map((value) => uint(value, 16).reverse()), Buffer.from([source.bumps.accounting])]).toString("hex");
        for (const [key, offset, value] of [[userCash, 64, 25_000_000n], [escrow, 64, 0n]] as const) {
          const data = Buffer.from(expectedAccount(key).dataHex, "hex"); data.writeBigUInt64LE(value, offset); expectedAccount(key).dataHex = data.toString("hex");
        }
        expectedAccount(operatorKey).lamports -= delivery.fee;
        assert.deepEqual(after.state.accounts, expected.accounts);
        assert.deepEqual(after.state.protocolAccounts, expected.protocolAccounts.map((item) => ({ ...item, account: expectedAccount(new PublicKey(item.address)) })));
        assert.deepEqual(after.state.activity, [{ signature: delivery.signature, slot: delivery.finalizedSlot, err: null, confirmationStatus: "finalized" }, ...before.state.activity]);
        for (const token of after.state.tokens) {
          const old = before.state.tokens.find((item) => item.mint === token.mint)!;
          assert.deepEqual(token.accounts, old.accounts.map((item) => ({ ...item, account: expectedAccount(new PublicKey(item.address)) })));
        }
        assert.equal(output.delivery.source.state, "Refunded"); assert.equal(output.delivery.source.cancellationRequested, true);
        assert.deepEqual(output.delivery.source.acceptedReceipt, { terminal: 2, filledQuantity: "0", receiptHash });
        const payer = delivery.balances.find((item) => item.address === operatorKey.toBase58())!;
        assert.equal(payer.before, 2_000_000n); assert.equal(payer.after, payer.before - delivery.fee);
        evidence.stages.delivery = { ...delivery, source: after, recoveredOriginalHash: output.observation.destination.kind === "Observed" ? output.observation.destination.transactionHash : null };
      }, false);
    });
    await check("worker C independently reads Refunded and matching Cancelled then returns Complete with no signing, submission or fees", async () => {
      // C receives only the original public identity/search shape. No B output,
      // receipt, decision or source delivery signature crosses this boundary.
      await attempt("C: fresh Complete", input, (output) => {
        assertCancelled(output, true); noSubmission(output);
        for (const earlier of evidence.attempts.slice(0, 2)) assert.notEqual(output.processId, earlier.processId);
        evidence.stages.complete = { processId: output.processId, plan: output.observation.plan,
          credentialReads: output.credentialReads, submissionCount: output.submissionCount, signingCount: output.signingCount };
      });
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
