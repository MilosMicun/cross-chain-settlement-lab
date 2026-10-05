import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { Bytes32Hex, EvmAddressHex, EvmTerms } from "../source-order.ts";
import type { DiscoverTerminalOutcomeInput, TerminalDiscoveryResult, TerminalDiscoveryRpc } from "../terminal-discovery.ts";
const { discoverTerminalOutcome, TerminalDiscoveryError } = await import(new URL("../terminal-discovery.ts", import.meta.url).href) as typeof import("../terminal-discovery.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-terminal-discovery.sh after its unchanged setup suite");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
const raw = (hex: string) => Buffer.from(hex.slice(2), "hex");
const sha = (value: Uint8Array) => `0x${createHash("sha256").update(value).digest("hex")}` as Bytes32Hex;
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const uint = (value: bigint, width: number) => Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
const allowedReads = ["eth_chainId", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"];
type RpcCall = { method: Parameters<TerminalDiscoveryRpc["send"]>[0]; params: unknown[]; response?: unknown; failure?: unknown };
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  return { address: key.toBase58(), account: info && { owner: info.owner.toBase58(), executable: info.executable,
    lamports: info.lamports, space: info.data.length, dataHex: info.data.toString("hex") } };
}
// Preserve public RPC failure details, including an EIP-1898 incompatibility, without signer material.
function publicError(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { code?: unknown; info?: unknown; cause?: unknown };
  return { name: error.name, message: error.message, code: detail.code, info: detail.info,
    cause: detail.cause === undefined ? undefined : publicError(detail.cause) };
}

test("live terminal rediscovery verifies EVM-only fixtures without source orders or receipt delivery", { timeout: 550_000 }, async (t) => {
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  let discovering = false;
  const sourceCalls: { method: string; duringDiscovery: boolean }[] = [];
  const providerCalls: string[] = [];
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      sourceCalls.push({ method: call.method, duringDiscovery: discovering });
      assert.equal(discovering, false, "Discovery must make zero source RPC calls");
      assert.ok(["getMultipleAccounts", "getProgramAccounts", "getSignaturesForAddress"].includes(call.method));
      assert.equal(call.params[1].commitment, "finalized");
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    },
  });
  const send = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    if (discovering) { providerCalls.push(method); assert.ok(allowedReads.includes(method), `Forbidden discovery provider RPC: ${method}`); }
    return send(method, params);
  };
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const setup = json("agreement-evidence.json") as { checks: string[]; failure?: unknown; observed: { agreement: LiveConfigurationObservation } };
  assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0);
  const agreement = setup.observed.agreement;
  const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
  const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider);
  const yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
  const evidence: { scope: string; limitations: string[]; checks: string[]; stages: Record<string, unknown>;
    observations: unknown[]; transactions: unknown[]; failure?: unknown } = {
    scope: "Live local terminal rediscovery only. Two explicitly EVM-only fixture orders establish neither finalized Solana user orders nor source cancellation requests; no completed cross-chain flow.",
    limitations: ["Trusted operator and local Anvil confirmation policy, not production finality or a cryptographic cross-chain proof.",
      "Cancelled does not authorize a source refund. NotFound is only a bounded negative search; it does not establish Unseen, refund eligibility or permission to resend.",
      "No source order creation, cancellation request, issuance, reimbursement, refund or receipt delivery; no process-restart coordinator, source delivery, automatic retry or bridge proof.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation remains; setup evidence records the deactivated feature."],
    checks: [], stages: { setupAgreement: agreement }, observations: [], transactions: [],
  };
  const persist = () => writeFileSync(join(runtime, "terminal-discovery-live-evidence.json"),
    JSON.stringify(evidence, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); }
      catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  function fixture(label: string, userByte: number, nonce: bigint, minimumShares: bigint, terminal: 1 | 2) {
    const d = agreement.evm.configuration;
    const terms: EvmTerms = { identity: { domain: { sourceDomain: d.sourceDomain as Bytes32Hex,
      destinationDomain: d.destinationDomain as Bytes32Hex, solanaProgram: d.solanaProgram as Bytes32Hex,
      chainId: BigInt(d.chainId), settlement: d.settlement as EvmAddressHex }, user: hex(Buffer.alloc(32, userByte)) as Bytes32Hex, nonce },
      market: d.market as Bytes32Hex, outcome: 0, cashAmount: 10_000_000n, minimumShares };
    // Independent SPEC fixed-width SHA-256 preimages, with no discovery/encoding-module calls.
    const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(BigInt(d.chainId), 32), raw(d.settlement)]);
    assert.equal(domain.length, 148);
    const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, raw(terms.identity.user), uint(nonce, 8)]);
    assert.equal(identityPreimage.length, 196);
    const orderId = sha(identityPreimage);
    const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, raw(orderId), raw(terms.identity.user), uint(nonce, 8),
      raw(d.market), Buffer.from([0]), uint(terms.cashAmount, 8), uint(minimumShares, 8)]);
    assert.equal(termsPreimage.length, 277);
    const termsHash = sha(termsPreimage);
    const quantity = terminal === 1 ? terms.cashAmount * 2n : 0n;
    const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), raw(termsHash), Buffer.from([terminal]), uint(quantity, 8)]);
    assert.equal(receiptPreimage.length, 49);
    return { label, sourceOrderEstablished: false, sourceCancellationEstablished: false, terms, orderId, termsHash,
      terminal, quantity, receiptHash: sha(receiptPreimage), preimages: { identity: hex(identityPreimage), terms: hex(termsPreimage), receipt: hex(receiptPreimage) } };
  }
  const filled = fixture("EVM-only Filled fixture", 0xb1, 27n, 20_000_000n, 1);
  const cancelled = fixture("EVM-only Cancelled fixture with unattainable positive minimum", 0xb2, 28n, 20_000_001n, 2);
  assert.notEqual(filled.orderId, cancelled.orderId); assert.notEqual(filled.terms.identity.user, cancelled.terms.identity.user);
  assert.notEqual(filled.terms.identity.nonce, cancelled.terms.identity.nonce);
  assert.ok(cancelled.terms.minimumShares > cancelled.terms.cashAmount * 2n);
  const unseen = fixture("Unsubmitted EVM-only fixture", 0xb3, 29n, 20_000_000n, 1);
  const conflict = fixture("Conflicting Filled minimum with the same identity", 0xb1, 27n, 19_999_999n, 1);
  assert.equal(conflict.orderId, filled.orderId); assert.notEqual(conflict.termsHash, filled.termsHash);
  evidence.stages.fixtures = [filled, cancelled, unseen, conflict];
  const programId = new PublicKey(source.programId), config = new PublicKey(source.accounts.config);
  const keys = [config, new PublicKey(source.accounts.accounting), new PublicKey(source.mints.cash), new PublicKey(source.mints.yes),
    new PublicKey(source.accounts.executorCashAta), programId, new PublicKey(source.programData)];
  for (const f of [filled, cancelled, unseen]) {
    const user = new PublicKey(raw(f.terms.identity.user));
    const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], programId);
    const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), uint(f.terms.identity.nonce, 8)], programId);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
    keys.push(user, userNonce, order, escrow);
  }
  async function sourceSnapshot() {
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot: agreement.solana.contextSlot });
    assert.ok(response.context.slot >= agreement.solana.contextSlot);
    const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
    const tokens = [];
    for (const mint of [new PublicKey(source.mints.cash), new PublicKey(source.mints.yes)]) {
      const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { commitment: "finalized", minContextSlot: response.context.slot,
        filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint.toBase58() } }] });
      const mintInfo = response.value[keys.findIndex((key) => key.equals(mint))]; assert.ok(mintInfo);
      const supply = unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID).supply;
      const balances = accounts.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), amount: unpackAccount(pubkey, account, TOKEN_PROGRAM_ID).amount }))
        .sort((a, b) => a.address.localeCompare(b.address));
      assert.equal(balances.reduce((sum, item) => sum + item.amount, 0n), supply);
      assert.equal(supply, 0n, "Setup source token supplies stay zero");
      tokens.push({ mint: mint.toBase58(), supply, balances, accounts: accounts.map(({ pubkey, account }) => publicAccount(pubkey, account))
        .sort((a, b) => a.address.localeCompare(b.address)) });
    }
    const activity = [];
    for (const key of keys.slice(0, 7)) {
      activity.push({ address: key.toBase58(), signatures: await connection.getSignaturesForAddress(key, { limit: 100 }, "finalized") });
    }
    assert.equal(protocol.value.length, 2, "Only setup Config and Accounting exist");
    assert.ok(response.value.slice(7).every((info) => info === null), "No source fixture user, nonce, order or escrow exists");
    const accountingInfo = response.value[1]; assert.ok(accountingInfo);
    const counters = Array.from({ length: 4 }, (_, index) => accountingInfo.data.readBigUInt64LE(40 + 16 * index)
      + (accountingInfo.data.readBigUInt64LE(48 + 16 * index) << 64n));
    assert.deepEqual(counters, [0n, 0n, 0n, 0n]);
    return { contextSlot: response.context.slot, protocolContextSlot: protocol.context.slot, state: {
      accounts: response.value.map((info, index) => publicAccount(keys[index], info)),
      protocolAccounts: protocol.value.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)),
      tokens, counters, activity } };
  }
  async function block(tag: string) {
    const value = await provider.send("eth_getBlockByNumber", [tag, false]); assert.ok(value);
    return { number: BigInt(value.number), hash: value.hash as Bytes32Hex };
  }
  async function economics() {
    const at = await block("latest");
    const read = (contract: Contract, name: string, ...args: unknown[]) => contract.getFunction(name).staticCall(...args, { blockTag: toQuantity(at.number) });
    const balances: Record<string, { supply: bigint; holders: Record<string, bigint> }> = {};
    for (const [name, token] of [["usd", usd], ["yes", yes]] as const) {
      const holders: Record<string, bigint> = {};
      for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
        holders[role] = await read(token, "balanceOf", address);
      }
      const supply: bigint = await read(token, "totalSupply");
      assert.equal(Object.values(holders).reduce((sum, amount) => sum + amount, 0n), supply, `${name} known balances conserve supply`);
      balances[name] = { supply, holders };
    }
    return { at, state: { balances,
      executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement) as bigint,
      venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue) as bigint,
      totalCashSpent: await read(settlement, "totalCashSpent") as bigint,
      totalSharesPurchased: await read(settlement, "totalSharesPurchased") as bigint } };
  }
  function expectedEconomics(spent: bigint) {
    return { balances: {
      usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 100_000_000n - spent, venue: spent, settlement: 0n } },
      yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 200_000_000n - 2n * spent, settlement: 2n * spent } },
    }, executorAllowance: 100_000_000n - spent, venueAllowance: 0n, totalCashSpent: spent, totalSharesPurchased: 2n * spent };
  }
  async function record(f: typeof filled, terminal: 0 | 1 | 2) {
    const actual = await settlement.getFunction("orderRecord").staticCall(f.orderId);
    if (terminal === 0) {
      assert.equal(actual.status, 0n); assert.equal(actual.termsHash, hex(Buffer.alloc(32)));
      assert.equal(actual.filledQuantity, 0n); assert.equal(actual.receiptHash, hex(Buffer.alloc(32)));
    } else {
      assert.equal(settlement.interface.encodeFunctionData("execute", [f.orderId, actual.terms]),
        settlement.interface.encodeFunctionData("execute", [f.orderId, f.terms]));
      assert.equal(actual.termsHash, f.termsHash); assert.equal(actual.status, BigInt(terminal));
      assert.equal(actual.filledQuantity, f.quantity); assert.equal(actual.receiptHash, f.receiptHash);
    }
    return settlement.interface.encodeFunctionResult("orderRecord", [actual]);
  }
  async function mine() { await provider.send("evm_mine", []); }
  const operator = await provider.getSigner(evm.roles.operator);
  assert.equal((await operator.getAddress()).toLowerCase(), agreement.evm.configuration.evmOperator);
  async function submit(f: typeof filled, method: "execute" | "cancel", event: boolean) {
    const before = await economics();
    const nativeBefore = await provider.getBalance(evm.roles.operator);
    // Fixture submission uses the existing unlocked operator, outside discovery.
    const tx = await operator.sendTransaction({ to: evm.contracts.settlement,
      data: settlement.interface.encodeFunctionData(method, [f.orderId, f.terms]), gasLimit: 1_000_000n });
    const receipt = await provider.waitForTransaction(tx.hash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, 1);
    const actual = await provider.send("eth_getTransactionReceipt", [tx.hash]);
    assert.equal(actual.status, "0x1"); assert.equal(actual.transactionHash, tx.hash);
    const transaction = await provider.send("eth_getTransactionByHash", [tx.hash]);
    assert.equal(transaction.from, agreement.evm.configuration.evmOperator);
    assert.equal(transaction.to, agreement.evm.configuration.settlement); assert.equal(transaction.value, "0x0");
    assert.equal(transaction.input, settlement.interface.encodeFunctionData(method, [f.orderId, f.terms]));
    assert.equal(BigInt(transaction.gas), 1_000_000n); assert.equal(BigInt(transaction.chainId), 31337n);
    const inclusion = await block(actual.blockNumber); assert.equal(inclusion.hash, actual.blockHash);
    assert.deepEqual(await block("latest"), inclusion, "Anvil inclusion is head before test mining");
    const events = receipt.logs.filter((log) => log.address.toLowerCase() === agreement.evm.configuration.settlement)
      .map((log) => settlement.interface.parseLog(log));
    if (event) {
      assert.equal(events.length, 1); assert.equal(events[0]?.name, "TerminalRecorded");
      assert.deepEqual(Array.from(events[0]!.args), [f.orderId, f.termsHash, BigInt(f.terminal), f.quantity, f.receiptHash]);
    } else assert.equal(receipt.logs.length, 0, "No new terminal event, Transfer, Approval or venue event");
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const nativeAfter = await provider.getBalance(evm.roles.operator); assert.equal(nativeAfter, nativeBefore - gasCost);
    const after = await economics();
    assert.deepEqual(after.state, expectedEconomics(10_000_000n));
    if (!event || f.terminal === 2) assert.deepEqual(after.state, before.state, "No token/counter/allowance effects");
    const saved = { fixture: f.label, method, transactionHash: tx.hash, receipt: actual, transaction, inclusion,
      gas: { gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice, gasCost, nativeBefore, nativeAfter }, economicsBefore: before, economicsAfter: after };
    evidence.transactions.push(saved); persist();
    return saved;
  }
  const terminalTopic = settlement.interface.getEvent("TerminalRecorded")!.topicHash;
  async function destinationSnapshot() {
    const economic = await economics();
    const native: Record<string, { balance: string; nonce: string }> = {};
    for (const address of new Set([...Object.values(evm.roles), ...Object.values(evm.contracts)])) {
      native[address] = {
        balance: await provider.send("eth_getBalance", [address, toQuantity(economic.at.number)]),
        nonce: await provider.send("eth_getTransactionCount", [address, toQuantity(economic.at.number)]),
      };
    }
    const records: Record<string, string> = {};
    for (const f of [filled, cancelled, unseen]) {
      const value = await settlement.getFunction("orderRecord").staticCall(f.orderId, { blockTag: toQuantity(economic.at.number) });
      records[f.orderId] = settlement.interface.encodeFunctionResult("orderRecord", [value]);
    }
    const events = await provider.send("eth_getLogs", [{ address: agreement.evm.configuration.settlement,
      fromBlock: "0x0", toBlock: toQuantity(economic.at.number), topics: [terminalTopic] }]);
    return { head: economic.at, economics: economic.state, native, records, events };
  }
  type SavedSubmission = Awaited<ReturnType<typeof submit>>;
  async function discover(label: string, f: typeof filled, fromBlock: bigint, toBlock: bigint,
    expected: "Confirmed" | "NotConfirmed" | "NotFound" | "BindingMismatch", original?: SavedSubmission) {
    const before = await destinationSnapshot();
    const sourceBefore = await sourceSnapshot();
    const calls: RpcCall[] = [];
    // No signer or other provider capability is reachable through this interface.
    const adapter: TerminalDiscoveryRpc = new Proxy({ async send(method: RpcCall["method"], params: unknown[]) {
      const call: RpcCall = { method, params: structuredClone(params) }; calls.push(call);
      assert.ok(allowedReads.includes(method), `Forbidden discovery RPC: ${method}`);
      try { const response = await provider.send(method, params); call.response = structuredClone(response); return response; }
      catch (error) { call.failure = publicError(error); throw error; }
    } }, { get(target, property, receiver) {
      assert.equal(property, "send", `Unexpected discovery capability: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    } });
    const search = { expectedConfiguration: agreement, orderId: f.orderId, termsHash: f.termsHash,
      terms: structuredClone(f.terms), fromBlock, toBlock };
    const input: DiscoverTerminalOutcomeInput = { provider: adapter, ...search };
    assert.deepEqual(Object.keys(input).sort(), ["provider", "expectedConfiguration", "orderId", "termsHash", "terms", "fromBlock", "toBlock"].sort());
    assert.equal("transactionHash" in input, false, "Submission evidence is never a discovery input");
    const sourceStart = sourceCalls.length, providerStart = providerCalls.length;
    let result: TerminalDiscoveryResult | undefined, failure: unknown;
    discovering = true;
    try { result = await discoverTerminalOutcome(input); }
    catch (error) { failure = error; }
    finally { discovering = false; }
    const sourceDuring = sourceCalls.length - sourceStart;
    const methods = providerCalls.slice(providerStart);
    const after = await destinationSnapshot();
    const sourceAfter = await sourceSnapshot();
    evidence.observations.push({ label, fixture: f.label, input: search, calls, result,
      error: failure === undefined ? undefined : publicError(failure), before, after, sourceBefore, sourceAfter,
      providerMethods: methods, sourceRpcCalls: sourceDuring,
      submissions: 0, mining: 0, signing: 0 });
    persist();
    assert.equal(sourceDuring, 0);
    assert.deepEqual(methods, calls.map((call) => call.method));
    assert.deepEqual(after, before, "Discovery preserves head, native balances/nonces, records, events and economics");
    assert.deepEqual(sourceAfter.state, sourceBefore.state, "Finalized source state/activity stays unchanged; context slots may advance");
    const logs = calls.filter((call) => call.method === "eth_getLogs");
    assert.equal(logs.length, 1, "Exactly one bounded terminal log query per attempt");
    assert.deepEqual(logs[0].params, [{ address: agreement.evm.configuration.settlement,
      fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock), topics: [terminalTopic, f.orderId] }]);
    assert.equal((logs[0].params[0] as { topics: string[] }).topics.length, 2, "Filter includes signature/orderId, never termsHash");
    if (expected === "BindingMismatch") {
      assert.ok(failure instanceof TerminalDiscoveryError); assert.equal(failure.code, "BindingMismatch");
      assert.equal(result, undefined);
      assert.equal((logs[0].response as unknown[]).length, 1, "Conflicting terms must find the real original event");
      return;
    }
    if (failure) throw failure;
    assert.ok(result);
    if (expected === "NotFound") {
      assert.deepEqual(result, { kind: "NotFound", searched: { fromBlock, toBlock } });
      assert.deepEqual(logs[0].response, []);
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getBlockByNumber"]);
      return;
    }
    assert.ok(original, "Independently saved submission is required only for assertions");
    assert.equal(result.kind, "Observed"); if (result.kind !== "Observed") assert.fail();
    assert.equal(result.transactionHash, original.transactionHash);
    const candidate = (logs[0].response as { transactionHash: string; blockNumber: string; blockHash: string }[]);
    assert.equal(candidate.length, 1); assert.equal(candidate[0].transactionHash, original.transactionHash);
    assert.equal(BigInt(candidate[0].blockNumber), original.inclusion.number);
    assert.equal(candidate[0].blockHash, original.inclusion.hash);
    const receiptReads = calls.filter((call) => call.method === "eth_getTransactionReceipt");
    assert.ok(receiptReads.length > 0);
    for (const call of receiptReads) {
      assert.deepEqual(call.params, [original.transactionHash]); assert.deepEqual(call.response, original.receipt);
    }
    if (expected === "NotConfirmed") {
      assert.deepEqual(result.observation, { kind: "NotConfirmed", reason: "InsufficientAdditionalBlocks" });
      assert.ok(before.head.number - original.inclusion.number < 2n);
      assert.equal(calls.some((call) => call.method === "eth_call"), false);
    } else {
      assert.deepEqual(result.observation, { kind: "Confirmed", orderId: f.orderId, termsHash: f.termsHash, terms: f.terms,
        receipt: { termsHash: f.termsHash, terminal: f.terminal, filledQuantity: f.quantity }, receiptHash: f.receiptHash,
        transactionHash: original.transactionHash, inclusion: original.inclusion, observationHead: before.head,
        additionalBlocks: before.head.number - original.inclusion.number });
      assert.ok(before.head.number >= original.inclusion.number + 2n);
      const reads = calls.filter((call) => call.method === "eth_call"); assert.equal(reads.length, 6);
      for (const [index, hash] of [original.inclusion.hash, before.head.hash].entries()) {
        const selected = reads.slice(index * 3, index * 3 + 3);
        assert.deepEqual(selected.map((call) => call.params[1]), Array(3).fill({ blockHash: hash, requireCanonical: true }));
        assert.deepEqual(selected.map((call) => call.params[0]), ["domain", "operator", "orderRecord"].map((name) => ({
          to: agreement.evm.configuration.settlement, data: settlement.interface.encodeFunctionData(name, name === "orderRecord" ? [f.orderId] : []) })));
      }
    }
  }
  let sourceBefore: Awaited<ReturnType<typeof sourceSnapshot>>;
  let destinationBefore: Awaited<ReturnType<typeof destinationSnapshot>>;
  let fillTx: SavedSubmission, cancelTx: SavedSubmission;
  let permanentFilled: string, permanentCancelled: string;
  const originals = new Map<string, SavedSubmission>();
  try {
    await check("reuse genuine setup on the same nodes with no source fixture orders", async () => {
      const live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: agreement.solana.contextSlot });
      assert.deepEqual(live.evm.configuration, agreement.evm.configuration); assert.deepEqual(live.solana.configuration, agreement.solana.configuration);
      destinationBefore = await destinationSnapshot(); assert.equal(destinationBefore.head.number, 9n);
      assert.deepEqual(destinationBefore.economics, expectedEconomics(0n)); assert.deepEqual(destinationBefore.events, []);
      for (const f of [filled, cancelled, unseen]) await record(f, 0);
      sourceBefore = await sourceSnapshot();
      evidence.stages.before = { destination: destinationBefore, source: sourceBefore, liveAgreement: live };
    });
    for (const f of [filled, cancelled]) {
      await check(`${f.label}: genuine status-1 terminal event and discovery at N`, async () => {
        const tx = await submit(f, f.terminal === 1 ? "execute" : "cancel", true);
        originals.set(f.orderId, tx);
        if (f.terminal === 1) { fillTx = tx; permanentFilled = await record(f, 1); }
        else { cancelTx = tx; permanentCancelled = await record(f, 2); }
        await discover(`${f.label} N`, f, tx.inclusion.number, tx.inclusion.number, "NotConfirmed", tx);
      });
      for (const additional of [1n, 2n]) {
        await check(`${f.label}: discovery at N+${additional}`, async () => {
          const tx = originals.get(f.orderId)!;
          await mine(); const at = await block("latest"); assert.equal(at.number, tx.inclusion.number + additional);
          await discover(`${f.label} N+${additional}`, f, tx.inclusion.number, at.number,
            additional === 2n ? "Confirmed" : "NotConfirmed", tx);
          await record(f, f.terminal as 1 | 2);
        });
      }
    }
    for (const f of [filled, cancelled]) {
      await check(`${f.label}: eventless replay recovers only original history; replay-only range is NotFound`, async () => {
        const original = originals.get(f.orderId)!;
        const replay = await submit(f, f.terminal === 1 ? "execute" : "cancel", false);
        assert.notEqual(replay.transactionHash, original.transactionHash);
        assert.ok(replay.inclusion.number > original.inclusion.number);
        await discover(`${f.label} range containing original and replay`, f, original.inclusion.number, replay.inclusion.number, "Confirmed", original);
        await discover(`${f.label} range after original covering replay only`, f, original.inclusion.number + 1n, replay.inclusion.number, "NotFound");
        assert.equal(await record(f, f.terminal as 1 | 2), f.terminal === 1 ? permanentFilled : permanentCancelled);
      });
    }
    await check("unsubmitted valid EVM-only identity has bounded NotFound and independently observed Unseen storage", async () => {
      const at = await block("latest"); await record(unseen, 0);
      await discover("Unsubmitted fixture; no submission or refund inference", unseen, destinationBefore.head.number, at.number, "NotFound");
      await record(unseen, 0);
    });
    await check("valid conflicting minimum retains identity and finds original event as BindingMismatch", async () => {
      await discover("Conflicting canonical terms", conflict, fillTx.inclusion.number, fillTx.inclusion.number, "BindingMismatch");
      assert.equal(await record(filled, 1), permanentFilled);
    });
    await check("final conservation, permanent records, separate operator gas and unchanged finalized source", async () => {
      const after = await sourceSnapshot(); assert.deepEqual(after.state, sourceBefore.state);
      const destination = await destinationSnapshot(); assert.deepEqual(destination.economics, expectedEconomics(10_000_000n));
      assert.equal(destination.events.length, 2);
      assert.equal(await record(filled, 1), permanentFilled); assert.equal(await record(cancelled, 2), permanentCancelled); await record(unseen, 0);
      const transactions = evidence.transactions as SavedSubmission[]; assert.equal(transactions.length, 4);
      const totalOperatorGas = transactions.reduce((sum, tx) => sum + tx.gas.gasCost, 0n);
      for (const [address, initial] of Object.entries(destinationBefore.native)) {
        const final = destination.native[address]; const isOperator = address.toLowerCase() === agreement.evm.configuration.evmOperator;
        assert.equal(BigInt(final.balance), BigInt(initial.balance) - (isOperator ? totalOperatorGas : 0n));
        assert.equal(BigInt(final.nonce), BigInt(initial.nonce) + (isOperator ? 4n : 0n));
      }
      assert.equal(sourceCalls.filter((call) => call.duringDiscovery).length, 0);
      evidence.stages.final = { destinationBefore, destinationAfter: destination, sourceBefore, sourceAfter: after,
        sourceStateUnchanged: true, sourceRpcCalls: sourceCalls, totalOperatorGas,
        originalTransactions: { filled: fillTx.transactionHash, cancelled: cancelTx.transactionHash },
        confirmationBlocks: { filled: fillTx.inclusion.number + 2n, cancelled: cancelTx.inclusion.number + 2n },
        receiptsDelivered: 0, sourceOrdersCreated: 0, sourceCancellationRequests: 0, sourceYesIssued: 0,
        sourceReimbursement: 0, sourceRefunds: 0, discoverySubmissions: 0, discoveryMining: 0, discoverySigning: 0, discoverySourceRpcCalls: 0 };
    });
  } catch (error) { evidence.failure = publicError(error); throw error; }
  finally { provider.destroy(); persist(); }
});
