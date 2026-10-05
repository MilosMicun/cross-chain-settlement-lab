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
import type { TerminalObservationResult, TerminalObservationRpc, TerminalReadMethod } from "../terminal-observation.ts";
const { observeTerminalOutcome, TerminalObservationError } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-terminal-observation.sh after its unchanged setup suite");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
const raw = (hex: string) => Buffer.from(hex.slice(2), "hex");
const sha = (value: Uint8Array) => `0x${createHash("sha256").update(value).digest("hex")}` as Bytes32Hex;
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const uint = (value: bigint, width: number) => Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
const allowedReads = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"];
type RpcCall = { method: TerminalReadMethod; params: unknown[]; response?: unknown; failure?: unknown };
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

test("live destination observer verifies EVM-only fixtures without source orders or receipt delivery", { timeout: 550_000 }, async (t) => {
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  let observing = false;
  const sourceCalls: { method: string; duringObservation: boolean }[] = [];
  const providerCalls: string[] = [];
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      sourceCalls.push({ method: call.method, duringObservation: observing });
      assert.equal(observing, false, "Observer must make zero source RPC calls");
      assert.ok(["getMultipleAccounts", "getProgramAccounts", "getSignaturesForAddress"].includes(call.method));
      assert.equal(call.params[1].commitment, "finalized");
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    },
  });
  const send = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    if (observing) { providerCalls.push(method); assert.ok(allowedReads.includes(method), `Forbidden observer provider RPC: ${method}`); }
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
    scope: "Local destination observation only. Two explicitly EVM-only fixture orders establish neither finalized Solana user orders nor source cancellation requests; no completed cross-chain flow.",
    limitations: ["Trusted operator and local Anvil confirmation policy, not production finality or a cryptographic cross-chain proof.",
      "Cancelled does not authorize a source refund. MissingReceipt does not establish Unseen, refund eligibility or permission to resend.",
      "No source order creation, cancellation request, issuance, reimbursement, refund or receipt delivery; no restart recovery.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation remains; setup evidence records the deactivated feature."],
    checks: [], stages: { setupAgreement: agreement }, observations: [], transactions: [],
  };
  const persist = () => writeFileSync(join(runtime, "terminal-observation-live-evidence.json"),
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
    // Independent SPEC fixed-width SHA-256 preimages, with no observer/encoding-module calls.
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
  const filled = fixture("EVM-only Filled fixture", 0xa1, 17n, 20_000_000n, 1);
  const cancelled = fixture("EVM-only Cancelled fixture with unattainable positive minimum", 0xa2, 18n, 20_000_001n, 2);
  assert.notEqual(filled.orderId, cancelled.orderId); assert.notEqual(filled.terms.identity.user, cancelled.terms.identity.user);
  assert.notEqual(filled.terms.identity.nonce, cancelled.terms.identity.nonce);
  assert.ok(cancelled.terms.minimumShares > cancelled.terms.cashAmount * 2n);
  evidence.stages.fixtures = [filled, cancelled];
  const programId = new PublicKey(source.programId), config = new PublicKey(source.accounts.config);
  const keys = [config, new PublicKey(source.accounts.accounting), new PublicKey(source.mints.cash), new PublicKey(source.mints.yes),
    new PublicKey(source.accounts.executorCashAta), programId, new PublicKey(source.programData)];
  for (const f of [filled, cancelled]) {
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
  async function submit(f: typeof filled, method: "execute" | "cancel", status: 0 | 1, event: boolean) {
    const before = await economics();
    const nativeBefore = await provider.getBalance(evm.roles.operator);
    // Explicit gas bypasses estimation; even the expected revert must really be mined.
    const tx = await operator.sendTransaction({ to: evm.contracts.settlement,
      data: settlement.interface.encodeFunctionData(method, [f.orderId, f.terms]), gasLimit: 1_000_000n });
    const receipt = await provider.waitForTransaction(tx.hash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, status);
    const actual = await provider.send("eth_getTransactionReceipt", [tx.hash]);
    assert.equal(actual.status, toQuantity(status)); assert.equal(actual.transactionHash, tx.hash);
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
  async function observe(label: string, f: typeof filled, transactionHash: string, expected: "Confirmed" | "NotConfirmed" | "FailedTransaction", reason?: string) {
    const at = await block("latest");
    const actualReceipt = await provider.send("eth_getTransactionReceipt", [transactionHash]);
    const calls: RpcCall[] = [];
    // This adapter offers only send; every request/response passes through unchanged.
    const adapter: TerminalObservationRpc = { async send(method, params) {
      const call: RpcCall = { method, params: structuredClone(params) }; calls.push(call);
      assert.ok(allowedReads.includes(method), `Forbidden observer RPC: ${method}`);
      try { const result = await provider.send(method, params); call.response = structuredClone(result); return result; }
      catch (error) { call.failure = publicError(error); throw error; }
    } };
    const sourceStart = sourceCalls.length, providerStart = providerCalls.length;
    let result: TerminalObservationResult | undefined, failure: unknown;
    observing = true;
    try { result = await observeTerminalOutcome({ provider: adapter, expectedConfiguration: agreement,
      orderId: f.orderId, termsHash: f.termsHash, terms: f.terms, transactionHash }); }
    catch (error) { failure = error; }
    finally { observing = false; }
    const observation = { label, fixture: f.label, transactionHash, head: at, actualReceipt, decision: result,
      error: failure === undefined ? undefined : publicError(failure), calls, providerMethods: providerCalls.slice(providerStart),
      sourceRpcCalls: sourceCalls.length - sourceStart, submissions: 0, mining: 0, signing: 0 };
    evidence.observations.push(observation); persist();
    assert.equal(sourceCalls.length, sourceStart);
    assert.deepEqual(providerCalls.slice(providerStart), calls.map((call) => call.method));
    assert.deepEqual(await block("latest"), at, "Observer never advances Anvil");
    if (expected === "FailedTransaction") {
      assert.ok(failure instanceof TerminalObservationError); assert.equal(failure.code, "FailedTransaction");
      assert.equal(result, undefined, "No attestable receipt on failure");
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt"]);
      return;
    }
    if (failure) throw failure;
    assert.ok(result); assert.equal(result.kind, expected);
    if (expected === "NotConfirmed") {
      assert.deepEqual(result, { kind: "NotConfirmed", reason });
      assert.equal("receipt" in result, false); assert.equal("receiptHash" in result, false);
      assert.equal(calls.some((call) => call.method === "eth_call"), false);
      assert.deepEqual(calls.map((call) => call.method), reason === "MissingReceipt" ? ["eth_chainId", "eth_getTransactionReceipt"]
        : ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"]);
    } else {
      assert.equal(result.kind, "Confirmed"); if (result.kind !== "Confirmed") assert.fail();
      const inclusion = await block(actualReceipt.blockNumber);
      assert.equal(inclusion.hash, actualReceipt.blockHash);
      assert.deepEqual(result, { kind: "Confirmed", orderId: f.orderId, termsHash: f.termsHash, terms: f.terms,
        receipt: { termsHash: f.termsHash, terminal: f.terminal, filledQuantity: f.quantity }, receiptHash: f.receiptHash,
        transactionHash, inclusion, observationHead: at, additionalBlocks: 2n });
      assert.equal(at.number, inclusion.number + 2n);
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber",
        "eth_getBlockByNumber", ...Array(6).fill("eth_call"), "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
      const reads = calls.filter((call) => call.method === "eth_call");
      for (const [index, hash] of [inclusion.hash, at.hash].entries()) {
        const selected = reads.slice(index * 3, index * 3 + 3);
        assert.deepEqual(selected.map((call) => call.params[1]), Array(3).fill({ blockHash: hash, requireCanonical: true }));
        assert.deepEqual(selected.map((call) => call.params[0]), ["domain", "operator", "orderRecord"].map((name) => ({
          to: agreement.evm.configuration.settlement, data: settlement.interface.encodeFunctionData(name, name === "orderRecord" ? [f.orderId] : []) })));
      }
    }
  }
  let sourceBefore: Awaited<ReturnType<typeof sourceSnapshot>>;
  let fillTx: Awaited<ReturnType<typeof submit>>;
  let permanentFilled: string, permanentCancelled: string;
  try {
    await check("reuse genuine setup agreement and prove both EVM fixtures are Unseen with no source orders", async () => {
      const live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: agreement.solana.contextSlot });
      assert.deepEqual(live.evm.configuration, agreement.evm.configuration); assert.deepEqual(live.solana.configuration, agreement.solana.configuration);
      const before = await economics(); assert.equal(before.at.number, 9n); assert.deepEqual(before.state, expectedEconomics(0n));
      await record(filled, 0); await record(cancelled, 0);
      sourceBefore = await sourceSnapshot(); evidence.stages.before = { economics: before, source: sourceBefore, liveAgreement: live };
    });
    await check("Filled actual status-1 inclusion N is NotConfirmed with exact economic effects", async () => {
      fillTx = await submit(filled, "execute", 1, true); permanentFilled = await record(filled, 1); await record(cancelled, 0);
      await observe("Filled N", filled, fillTx.transactionHash, "NotConfirmed", "InsufficientAdditionalBlocks");
      assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    await check("one additional test-mined block N+1 remains NotConfirmed", async () => {
      await mine(); assert.equal((await block("latest")).number, fillTx.inclusion.number + 1n);
      await observe("Filled N+1", filled, fillTx.transactionHash, "NotConfirmed", "InsufficientAdditionalBlocks");
      assert.equal(await record(filled, 1), permanentFilled); assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    await check("second additional block N+2 confirms exact Filled through canonical EIP-1898 history", async () => {
      await mine(); await observe("Filled N+2", filled, fillTx.transactionHash, "Confirmed");
      assert.equal(await record(filled, 1), permanentFilled); assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    await check("cancel Unseen unattainable-minimum EVM fixture: zero token effects, Cancelled at N+2", async () => {
      await record(cancelled, 0);
      const tx = await submit(cancelled, "cancel", 1, true); permanentCancelled = await record(cancelled, 2);
      await mine(); await mine(); await observe("Cancelled N+2; no source refund authorization", cancelled, tx.transactionHash, "Confirmed");
      assert.equal(await record(filled, 1), permanentFilled); assert.equal(await record(cancelled, 2), permanentCancelled);
      assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    for (const method of ["execute", "cancel"] as const) {
      await check(`${method} replay of Filled succeeds without events or economics and observes existing Filled`, async () => {
        const tx = await submit(filled, method, 1, false);
        await mine(); await mine(); await observe(`Filled ${method} replay N+2`, filled, tx.transactionHash, "Confirmed");
        assert.equal(await record(filled, 1), permanentFilled); assert.equal(await record(cancelled, 2), permanentCancelled);
        assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
      });
    }
    await check("actual mined execute of Cancelled fails OrderCancelled and observer throws FailedTransaction", async () => {
      const tx = await submit(cancelled, "execute", 0, false);
      const trace = await provider.send("debug_traceTransaction", [tx.transactionHash, { disableStorage: true, disableMemory: true, disableStack: true }]);
      const expectedRevert = settlement.interface.encodeErrorResult("OrderCancelled", [cancelled.orderId]);
      evidence.stages.failedExecution = { transactionHash: tx.transactionHash, failed: trace.failed, returnValue: trace.returnValue,
        expectedError: "OrderCancelled", expectedRevert };
      persist(); assert.equal(trace.failed, true); assert.equal(`0x${String(trace.returnValue).replace(/^0x/, "")}`, expectedRevert);
      await mine(); await mine(); await observe("Actual status-0 receipt", cancelled, tx.transactionHash, "FailedTransaction");
      assert.equal(await record(cancelled, 2), permanentCancelled); assert.equal(await record(filled, 1), permanentFilled);
      assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    await check("real RPC missing receipt has no attestable content or inferred resend/refund permission", async () => {
      const unusedHash = sha(Buffer.from(`Task 5C4 unused transaction ${agreement.evm.configuration.sourceDomain}`));
      assert.equal(await provider.send("eth_getTransactionByHash", [unusedHash]), null);
      await observe("MissingReceipt; no Unseen inference or resend/refund permission", filled, unusedHash, "NotConfirmed", "MissingReceipt");
      assert.equal(await record(filled, 1), permanentFilled); assert.equal(await record(cancelled, 2), permanentCancelled);
      assert.deepEqual((await economics()).state, expectedEconomics(10_000_000n));
    });
    await check("final permanent records, conservation and source protocol/token/activity remain unchanged", async () => {
      const after = await sourceSnapshot(); assert.deepEqual(after.state, sourceBefore.state, "Compare account state, not advancing context slots");
      const events = await settlement.queryFilter(settlement.filters.TerminalRecorded(), 0, "latest"); assert.equal(events.length, 2);
      const economic = await economics(); assert.deepEqual(economic.state, expectedEconomics(10_000_000n));
      assert.equal(await record(filled, 1), permanentFilled); assert.equal(await record(cancelled, 2), permanentCancelled);
      assert.equal(sourceCalls.filter((call) => call.duringObservation).length, 0);
      evidence.stages.final = { economics: economic, permanentFilled, permanentCancelled, terminalEvents: events.map((event) => event.toJSON()),
        sourceBefore, sourceAfter: after, sourceStateUnchanged: true, sourceRpcCalls: sourceCalls,
        receiptsDelivered: 0, sourceOrdersCreated: 0, sourceCancellationRequests: 0, sourceYesIssued: 0, sourceReimbursement: 0, sourceRefunds: 0,
        liveEip1898Supported: true, observerSubmissions: 0, observerMining: 0, observerSigning: 0, observerSourceRpcCalls: 0 };
    });
  } catch (error) { evidence.failure = publicError(error); throw error; }
  finally { provider.destroy(); persist(); }
});
