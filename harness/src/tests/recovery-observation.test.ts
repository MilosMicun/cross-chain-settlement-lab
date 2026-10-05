import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BorshAccountsCoder, convertIdlToCamelCase, type Idl } from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { Interface, toQuantity } from "ethers";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { ReadFinalizedRecoveryOrderInput, SourceOrderConnection } from "../source-order.ts";
import type { ObserveRecoveryInput } from "../recovery-observation.ts";
import type { TerminalDiscoveryRpc } from "../terminal-discovery.ts";
const { observeRecovery } = await import(new URL("../recovery-observation.ts", import.meta.url).href) as typeof import("../recovery-observation.ts");
const { SourceOrderError } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { TerminalDiscoveryError } = await import(new URL("../terminal-discovery.ts", import.meta.url).href) as typeof import("../terminal-discovery.ts");
const { TerminalObservationError } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { RecoveryPlanError } = await import(new URL("../recovery-plan.ts", import.meta.url).href) as typeof import("../recovery-plan.ts");
const abi = new Interface(JSON.parse(readFileSync(new URL("../../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);

// Explicit public synthetic fixtures only. No keys, providers, nodes or network.
// Independent manual Borsh/SPL layouts and SHA-256 preimages; neither the adapter
// nor protocol-encoding.ts builds expected records, hashes or EVM terms.
const program = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const publicKey = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
const user = publicKey(0x55);
const operator = publicKey(0x81);
const executor = publicKey(0xc1);
const cashMint = publicKey(0x71);
const yesMint = publicKey(0x72);
const hash = (data: Buffer) => createHash("sha256").update(data).digest();
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const asHex = (data: Uint8Array) => `0x${Buffer.from(data).toString("hex")}`;
function uint(value: bigint, width: number, endian: "be" | "le" = "be"): Buffer {
  const hex = value.toString(16).padStart(width * 2, "0");
  assert.equal(hex.length, width * 2);
  const bytes = Buffer.from(hex, "hex");
  return endian === "le" ? bytes.reverse() : bytes;
}
const shared: SharedConfiguration = {
  sourceDomain: "0x" + "11".repeat(32), destinationDomain: "0x" + "22".repeat(32),
  solanaProgram: "0x67d68836c516e28f6fa10a3bcc609744f71f4a8f8768f58ec23064deff17a2cc",
  chainId: "31337", settlement: "0x" + "44".repeat(20), market: "0x" + "66".repeat(32),
  venue: "0x" + "91".repeat(20), cashToken: "0x" + "92".repeat(20), yesToken: "0x" + "93".repeat(20),
  evmOperator: "0x" + "94".repeat(20), evmExecutor: "0x" + "95".repeat(20),
};
type FixtureOptions = { state?: 0 | 1 | 2 | 3; nonce?: bigint; cash?: bigint; minimum?: bigint };
function sourceFixture(options: FixtureOptions = {}) {
  const chainId = 31337n;
  const nonce = options.nonce ?? 7n;
  const cash = options.cash ?? 10_000_000n;
  const minimum = options.minimum ?? 20_000_000n;
  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], program);
  const [userNonce, userBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], program);
  const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), uint(nonce, 8)], program);
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], program);
  const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], program);
  const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], program);
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const cashAta = ata(cashMint, user);
  const yesAta = ata(yesMint, user);
  const executorAta = ata(cashMint, executor);
  const domain = Buffer.concat([raw(shared.sourceDomain), raw(shared.destinationDomain), raw(shared.solanaProgram), uint(chainId, 32), raw(shared.settlement)]);
  const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
  const orderId = hash(identityPreimage);
  const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.toBuffer(), uint(nonce, 8), raw(shared.market), Buffer.from([0]), uint(cash, 8), uint(minimum, 8)]);
  const termsHash = hash(termsPreimage);
  assert.equal(identityPreimage.length, 196);
  assert.equal(termsPreimage.length, 277);
  const configData = Buffer.concat([
    Buffer.from("9b0caae01efacc82", "hex"), Buffer.from([1]), raw(shared.sourceDomain), raw(shared.destinationDomain), program.toBuffer(), uint(chainId, 32),
    ...[shared.settlement, shared.venue, shared.cashToken, shared.yesToken, shared.evmOperator, shared.evmExecutor].map(raw), raw(shared.market), Buffer.from([0]),
    ...[operator, executor, cashMint, yesMint, executorAta, yesAuthority, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId].map((key) => key.toBuffer()),
    Buffer.from([configBump, yesBump]),
  ]);
  assert.equal(configData.length, 580);
  const nonceData = Buffer.concat([Buffer.from("eb8501f3128758e0", "hex"), config.toBuffer(), user.toBuffer(), uint(nonce + 1n, 8, "le"), Buffer.from([userBump])]);
  const state = options.state ?? 0;
  const hasReceipt = state >= 2;
  const terminal = state === 3 ? 2 : 1;
  const quantity = state === 3 ? 0n : cash * 2n;
  const receiptHash = hash(Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([terminal]), uint(quantity, 8)]));
  const orderSerialized = Buffer.concat([
    Buffer.from("86addfb94d561c33", "hex"), config.toBuffer(), user.toBuffer(), uint(nonce, 8, "le"), raw(shared.market), Buffer.from([0]),
    uint(cash, 8, "le"), uint(minimum, 8, "le"), orderId, termsHash, cashAta.toBuffer(), yesAta.toBuffer(), escrow.toBuffer(),
    Buffer.from([state, Number(state === 1 || state === 3), Number(hasReceipt)]),
    ...(hasReceipt ? [Buffer.from([terminal]), uint(quantity, 8, "le"), receiptHash] : []), Buffer.from([orderBump, escrowBump]),
  ]);
  const orderData = Buffer.alloc(335);
  orderSerialized.copy(orderData);
  const balance = state >= 2 ? 0n : cash;
  const escrowData = Buffer.alloc(165);
  cashMint.toBuffer().copy(escrowData, 0);
  order.toBuffer().copy(escrowData, 32);
  uint(balance, 8, "le").copy(escrowData, 64);
  escrowData[108] = 1;
  const info = (data: Buffer, owner = program): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports: 1_000_000, rentEpoch: 0 });
  const records = [info(configData), info(nonceData), info(orderData), info(escrowData, TOKEN_PROGRAM_ID)];
  const localConfig = { address: config.toBase58(), owner: program.toBase58(), dataHex: configData.toString("hex"), version: 1, outcome: 0,
    bump: configBump, yesAuthorityBump: yesBump, operator: operator.toBase58(), executor: executor.toBase58(), cashMint: cashMint.toBase58(), yesMint: yesMint.toBase58(),
    executorCashAta: executorAta.toBase58(), yesAuthority: yesAuthority.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), systemProgram: SystemProgram.programId.toBase58() };
  const expectedConfiguration: LiveConfigurationObservation = {
    scope: "Synthetic controlled RPC fixture; not live verification evidence",
    evm: { blockNumber: 4, blockHash: "0x" + "ab".repeat(32), rpcChainId: chainId.toString(), configuration: { ...shared, chainId: chainId.toString() },
      venue: { cashToken: shared.cashToken, yesToken: shared.yesToken, market: shared.market }, tokenDecimals: { cash: "6", yes: "6" }, codeBytes: {} },
    solana: { contextSlot: 100, minContextSlot: 90, commitment: "finalized", configuration: { ...shared, chainId: chainId.toString() }, config: localConfig,
      accounting: { address: accounting.toBase58(), owner: program.toBase58(), config: config.toBase58(), bump: accountingBump, counters: ["10000000", "0", "0", "0"] },
      mints: { cash: { address: cashMint.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: operator.toBase58(), freezeAuthority: null, supply: "100000000" },
        yes: { address: yesMint.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: yesAuthority.toBase58(), freezeAuthority: null, supply: "0" } },
      executorCashAta: { address: executorAta.toBase58(), owner: executor.toBase58(), mint: cashMint.toBase58(), amount: "0" },
      program: { address: program.toBase58(), owner: loader.toBase58(), executable: true, programData: programData.toBase58(),
        programDataOwner: loader.toBase58(), deploymentSlot: "1", upgradeAuthority: null, loadedImageSha256: "ab".repeat(32) } },
  };
  const addresses = [config, userNonce, order, escrow];
  const response: Awaited<ReturnType<SourceOrderConnection["getMultipleAccountsInfoAndContext"]>> = { context: { slot: 123 }, value: records };
  let calls = 0;
  const connection = new Proxy<SourceOrderConnection>({
    async getMultipleAccountsInfoAndContext(keys, request) {
      calls += 1;
      assert.equal(calls, 1, "Exactly one read-only RPC request");
      assert.deepEqual(keys.map((key) => key.toBase58()), addresses.map((key) => key.toBase58()));
      assert.deepEqual(request, { commitment: "finalized", minContextSlot: 110 });
      return response;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "getMultipleAccountsInfoAndContext", `Unexpected RPC or transaction method: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  const input: ReadFinalizedRecoveryOrderInput = { connection, expectedConfiguration, user: new PublicKey(user.toBytes()), nonce, minFinalizedSlot: 110 };
  const expectedOutput = { accounts: { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
    userCashAta: cashAta.toBase58(), userYesAta: yesAta.toBase58() }, contextSlot: 123, state: (["Pending", "CancelRequested", "Settled", "Refunded"] as const)[state],
    cancellationRequested: state === 1 || state === 3,
    acceptedReceipt: hasReceipt ? { terminal, filledQuantity: quantity, receiptHash: asHex(receiptHash) } : null, orderId: asHex(orderId), termsHash: asHex(termsHash), escrowBalance: balance,
  terms: { identity: { domain: { sourceDomain: shared.sourceDomain, destinationDomain: shared.destinationDomain, solanaProgram: shared.solanaProgram,
    chainId, settlement: shared.settlement }, user: "0x" + "55".repeat(32), nonce }, market: shared.market, outcome: 0, cashAmount: cash, minimumShares: minimum } };
  return { input, records, response, expectedOutput, addresses, orderSerialized, calls: () => calls };
}
type Call = { method: Parameters<TerminalDiscoveryRpc["send"]>[0]; params: unknown[]; occurrence: number };
const b32 = (byte: string) => "0x" + byte.repeat(32);
function fixture(options: FixtureOptions & { terminal?: 1 | 2; additional?: bigint } = {}) {
  const source = sourceFixture(options);
  const { terms, orderId: id, termsHash: digest } = source.expectedOutput;
  const terminal = options.terminal ?? 1;
  const quantity = terminal === 1 ? terms.cashAmount * 2n : 0n;
  const receiptHash = asHex(hash(Buffer.concat([Buffer.from("CCSLRC01"), raw(digest), Buffer.from([terminal]), uint(quantity, 8)])));
  const transactionHash = b32("ee");
  const inclusion = { number: 10n, hash: b32("cc") };
  const head = { number: 10n + (options.additional ?? 2n), hash: b32("dd") };
  const encoded = abi.encodeEventLog(abi.getEvent("TerminalRecorded")!, [id, digest, terminal, quantity, receiptHash]);
  const log = { address: shared.settlement, topics: encoded.topics, data: encoded.data, transactionHash,
    blockHash: inclusion.hash, blockNumber: "0xa", transactionIndex: "0x0", logIndex: "0x3", removed: false };
  const logs: unknown[] = [log];
  const receipt = { transactionHash, status: "0x1", from: shared.evmOperator, to: shared.settlement,
    blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: "0x0", logs: [structuredClone(log)] };
  const transaction = { hash: transactionHash, from: shared.evmOperator, to: shared.settlement, chainId: "0x7a69", value: "0x0",
    blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: "0x0",
    input: abi.encodeFunctionData(terminal === 1 ? "execute" : "cancel", [id, terms]) };
  const record = { terms: structuredClone(terms), termsHash: digest, status: BigInt(terminal), filledQuantity: quantity, receiptHash };
  const calls: Call[] = [];
  const sequence: string[] = [];
  let sourceHook: ((response: typeof source.response) => Promise<typeof source.response>) | undefined;
  let destinationHook: ((call: Call, response: unknown) => unknown | Promise<unknown>) | undefined;
  const sourceConnection = new Proxy<SourceOrderConnection>({
    async getMultipleAccountsInfoAndContext(keys, request) {
      sequence.push("source");
      const response = await source.input.connection.getMultipleAccountsInfoAndContext(keys, request);
      return sourceHook ? sourceHook(response) : response;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "getMultipleAccountsInfoAndContext", `Forbidden source capability: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  const destinationProvider = new Proxy<TerminalDiscoveryRpc>({
    async send(method, params) {
      const call: Call = { method, params: structuredClone(params), occurrence: calls.filter((c) => c.method === method).length + 1 };
      calls.push(call);
      sequence.push(method);
      let response: unknown;
      switch (method) {
        case "eth_chainId": assert.deepEqual(params, []); response = "0x7a69"; break;
        case "eth_getLogs": response = logs; break;
        case "eth_getTransactionReceipt": assert.deepEqual(params, [transactionHash]); response = receipt; break;
        case "eth_getTransactionByHash": assert.deepEqual(params, [transactionHash]); response = transaction; break;
        case "eth_getBlockByNumber": {
          assert.equal(params[1], false);
          const block = params[0] === "latest" ? head : params[0] === "0xc" ? { number: 12n, hash: b32("dd") } : inclusion;
          response = { number: toQuantity(block.number), hash: block.hash }; break;
        }
        case "eth_call": {
          const request = params[0] as { to: string; data: string };
          const tag = params[1] as { blockHash: string; requireCanonical: boolean };
          assert.equal(request.to, shared.settlement);
          assert.deepEqual(tag, { blockHash: tag.blockHash, requireCanonical: true });
          assert.ok([inclusion.hash, head.hash].includes(tag.blockHash));
          const parsed = abi.parseTransaction({ data: request.data }); assert.ok(parsed);
          assert.ok(["domain", "operator", "orderRecord"].includes(parsed.name));
          if (parsed.name === "orderRecord") assert.equal(parsed.args[0], id);
          response = abi.encodeFunctionResult(parsed.name, [parsed.name === "domain" ? terms.identity.domain
            : parsed.name === "operator" ? shared.evmOperator : record]);
          break;
        }
        default: assert.fail(`Forbidden destination RPC: ${String(method)}`);
      }
      return destinationHook ? destinationHook(call, response) : response;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "send", `Forbidden destination capability: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  const input = { sourceConnection, destinationProvider, expectedConfiguration: source.input.expectedConfiguration,
    user: source.input.user, nonce: source.input.nonce, minFinalizedSlot: source.input.minFinalizedSlot, fromBlock: 0n, toBlock: 12n } satisfies ObserveRecoveryInput;
  const destinationOutput = { kind: "Observed", transactionHash, observation: { kind: "Confirmed", orderId: id, termsHash: digest,
    terms: structuredClone(terms), receipt: { termsHash: digest, terminal, filledQuantity: quantity }, receiptHash,
    transactionHash, inclusion, observationHead: head, additionalBlocks: head.number - inclusion.number } };
  return { ...source, input, calls, sequence, logs, log, receipt, transaction, record, receiptHash, destinationOutput,
    sourceHook: (hook: typeof sourceHook) => { sourceHook = hook; },
    destinationHook: (hook: typeof destinationHook) => { destinationHook = hook; } };
}

for (const [state, terminal, kind, reason] of [
  [0, 1, "DeliverFilled", undefined],
  [1, 1, "DeliverFilled", undefined],
  [0, 2, "Wait", "SourceCancellationRequired"],
  [1, 2, "DeliverCancelled", undefined],
  [2, 1, "Complete", undefined],
  [3, 2, "Complete", undefined],
] as const) {
  test(`${["Pending", "CancelRequested", "Settled", "Refunded"][state]} + confirmed terminal ${terminal} -> ${reason ?? kind}`, async () => {
    const f = fixture({ state, terminal });
    const result = await observeRecovery(f.input);
    const identity = { orderId: f.expectedOutput.orderId, termsHash: f.expectedOutput.termsHash };
    const expectedPlan = kind === "Wait" ? { ...identity, kind, reason }
      : kind === "Complete" ? { ...identity, kind, sourceState: f.expectedOutput.state, receiptHash: f.receiptHash }
      : { ...identity, kind, receiptHash: f.receiptHash };
    assert.deepEqual(result, { source: f.expectedOutput, destination: f.destinationOutput, plan: expectedPlan });
    assert.equal(f.sequence[0], "source");
    assert.equal(f.sequence.filter((c) => c === "source").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, 1);
  });
}
for (const [state, terminal] of [[2, 2], [3, 1]] as const) {
  test(`terminal source ${state} conflicting with destination ${terminal} remains a typed planner error`, async () => {
    const f = fixture({ state, terminal });
    await assert.rejects(observeRecovery(f.input), (error) => error instanceof RecoveryPlanError && error.code === "TerminalConflict");
    assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, 1);
  });
}
for (const state of [0, 1, 2, 3] as const) {
  for (const missing of [true, false]) {
    test(`source ${state} with ${missing ? "NotFound" : "NotConfirmed"} waits without implying Unseen or Complete`, async () => {
      const f = fixture({ state, additional: 1n });
      if (missing) f.logs.length = 0;
      const result = await observeRecovery(f.input);
      assert.deepEqual(result.source, f.expectedOutput);
      assert.deepEqual(result.destination, missing ? { kind: "NotFound", searched: { fromBlock: 0n, toBlock: 12n } }
        : { kind: "Observed", transactionHash: f.log.transactionHash,
          observation: { kind: "NotConfirmed", reason: "InsufficientAdditionalBlocks" } });
      assert.deepEqual(result.plan, { orderId: f.expectedOutput.orderId, termsHash: f.expectedOutput.termsHash,
        kind: "Wait", reason: missing ? "DestinationNotObserved" : "DestinationNotConfirmed" });
      assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, 1);
    });
  }
}

test("manual source records agree with the actual IDL and independently built terms", () => {
  const idl = JSON.parse(readFileSync(new URL("../../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as Idl;
  assert.equal(idl.address, program.toBase58());
  const coder = new BorshAccountsCoder(convertIdlToCamelCase(idl));
  for (const state of [0, 1, 2, 3] as const) {
    const f = fixture({ state });
    const decoded = coder.decode("order", f.records[2].data);
    assert.equal(Object.keys(decoded.state)[0], ["pending", "cancelRequested", "settled", "refunded"][state]);
    assert.equal(asHex(decoded.orderId), f.expectedOutput.orderId);
    assert.equal(asHex(decoded.termsHash), f.expectedOutput.termsHash);
    assert.equal(BigInt(decoded.cashAmount.toString()), f.expectedOutput.terms.cashAmount);
    if (state >= 2) assert.equal(asHex(decoded.acceptedReceipt.receiptHash), f.expectedOutput.acceptedReceipt!.receiptHash);
    else assert.equal(decoded.acceptedReceipt, null);
  }
});

test("one finalized four-account read precedes one bounded source-derived search and actual observer reads", async () => {
  const f = fixture({ nonce: 19n, cash: 12_345_678n, minimum: 23_000_000n });
  let resolveRead!: (response: typeof f.response) => void;
  f.sourceHook(() => new Promise((resolve) => { resolveRead = resolve; }));
  const pending = observeRecovery(f.input);
  // The controlled source wrapper first yields its response to the hook.
  await Promise.resolve();
  assert.deepEqual(f.sequence, ["source"]);
  assert.equal(f.calls.length, 0);
  resolveRead(f.response);
  const result = await pending;
  assert.deepEqual(result.source, f.expectedOutput);
  assert.deepEqual(result.destination, f.destinationOutput);
  assert.deepEqual(f.sequence.slice(0, 6), ["source", "eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionReceipt", "eth_chainId"]);
  const searches = f.calls.filter((c) => c.method === "eth_getLogs");
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].params, [{ address: shared.settlement, fromBlock: "0x0", toBlock: "0xc",
    topics: [abi.getEvent("TerminalRecorded")!.topicHash, f.expectedOutput.orderId] }]);
  assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 6);
  assert.deepEqual(f.calls.filter((c) => c.method === "eth_getTransactionReceipt").map((c) => c.occurrence), [1, 2, 3], "Discovery, observation and canonical recheck only");
  assert.equal(f.calls.filter((c) => c.method === "eth_getTransactionByHash").length, 1);
  assert.equal(f.calls.at(-1)!.method, "eth_getBlockByNumber");
  assert.deepEqual(f.calls.at(-1)!.params, ["0xc", false]);
  assert.equal("transactionHash" in f.input, false);
  assert.equal("orderId" in f.input, false);
  assert.equal("termsHash" in f.input, false);
});

for (const failureMode of ["rpc", "account", "configuration"] as const) {
  test(`source ${failureMode} failure prevents every destination read`, async () => {
    const f = fixture();
    const failure = new Error("controlled source RPC failure");
    if (failureMode === "rpc") f.sourceHook(async () => { throw failure; });
    if (failureMode === "account") f.records[2].data[129] ^= 1;
    if (failureMode === "configuration") f.records[0].data[9] ^= 1;
    await assert.rejects(observeRecovery(f.input), (error) => failureMode === "rpc" ? error === failure
      : error instanceof SourceOrderError && error.code === (failureMode === "account" ? "HashMismatch" : "ConfigurationMismatch"));
    assert.deepEqual(f.sequence, ["source"]);
    assert.equal(f.calls.length, 0);
  });
}
for (const failureMode of ["rpc", "discovery", "observer", "binding", "sourceTerms"] as const) {
  test(`${failureMode} destination failure propagates without a successful observation or plan`, async () => {
    const f = fixture();
    const failure = new Error("controlled destination RPC failure");
    if (failureMode === "rpc") f.destinationHook((c, response) => { if (c.method === "eth_getLogs") throw failure; return response; });
    if (failureMode === "discovery") f.log.removed = true;
    if (failureMode === "observer") f.transaction.from = shared.evmExecutor;
    if (failureMode === "binding") f.input.expectedConfiguration.evm.configuration.market = b32("77");
    if (failureMode === "sourceTerms") {
      f.input.expectedConfiguration.evm.configuration.market = b32("77");
      f.input.expectedConfiguration.solana.configuration.market = b32("77");
    }
    await assert.rejects(observeRecovery(f.input), (error) => failureMode === "observer"
      ? error instanceof TerminalObservationError && error.code === "BindingMismatch"
      : error instanceof TerminalDiscoveryError && error.code === (failureMode === "rpc" ? "RpcFailure"
        : failureMode === "discovery" ? "MalformedEvidence" : "BindingMismatch") && (failureMode !== "rpc" || error.cause === failure));
    assert.equal(f.sequence.filter((c) => c === "source").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length,
      failureMode === "binding" || failureMode === "sourceTerms" ? 0 : 1);
  });
}

test("all caller values and network references are captured before the source await", async () => {
  const f = fixture();
  let resolveRead!: (response: typeof f.response) => void;
  f.sourceHook(() => new Promise((resolve) => { resolveRead = resolve; }));
  const pending = observeRecovery(f.input);
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  // Mutate the original PublicKey object as well as its input property.
  const changedUser = publicKey(0x56);
  Object.assign(f.input.user, changedUser);
  Object.assign(f.input, { user: changedUser, nonce: 99n, minFinalizedSlot: 999, fromBlock: 99n, toBlock: 100n,
    sourceConnection: { getMultipleAccountsInfoAndContext: () => assert.fail("Replacement source used") },
    destinationProvider: { send: () => assert.fail("Replacement destination used") } });
  f.input.expectedConfiguration.evm.configuration.settlement = "0x" + "aa".repeat(20);
  f.input.expectedConfiguration.solana.configuration.market = b32("bb");
  f.input.expectedConfiguration.solana.config.dataHex = "ff".repeat(580);
  f.input.expectedConfiguration.evm.rpcChainId = "1";
  resolveRead(f.response);
  const result = await pending;
  assert.deepEqual(result.source, f.expectedOutput);
  assert.deepEqual(result.destination, f.destinationOutput);
  assert.equal(result.plan.kind, "DeliverFilled");
  assert.deepEqual(f.calls.find((c) => c.method === "eth_getLogs")!.params, [{ address: shared.settlement,
    fromBlock: "0x0", toBlock: "0xc", topics: [abi.getEvent("TerminalRecorded")!.topicHash, f.expectedOutput.orderId] }]);
});

function snapshot(f: ReturnType<typeof fixture>) {
  return { configuration: structuredClone(f.input.expectedConfiguration), user: f.input.user.toBytes(),
    nonce: f.input.nonce, slot: f.input.minFinalizedSlot, fromBlock: f.input.fromBlock, toBlock: f.input.toBlock,
    response: { context: { ...f.response.context }, value: f.response.value.map((record) => record === null ? null
      : { ...record, data: Buffer.from(record.data), owner: record.owner.toBase58() }) },
    destination: structuredClone({ logs: f.logs, receipt: f.receipt, transaction: f.transaction, record: f.record }) };
}
for (const succeeds of [true, false]) {
  test(`caller inputs and RPC responses remain unchanged on ${succeeds ? "success" : "rejection"}`, async () => {
    const f = fixture({ state: 2 });
    if (!succeeds) f.transaction.from = shared.evmExecutor;
    const before = snapshot(f);
    if (succeeds) await observeRecovery(f.input);
    else await assert.rejects(observeRecovery(f.input), TerminalObservationError);
    assert.deepEqual(snapshot(f), before);
  });
}
test("returned nested results own their data across components and explicit attempts", async () => {
  const f = fixture({ state: 2 });
  const before = snapshot(f);
  const first = await observeRecovery(f.input);
  assert.equal(first.destination.kind, "Observed");
  if (first.destination.kind !== "Observed") assert.fail("Expected observation");
  assert.equal(first.destination.observation.kind, "Confirmed");
  if (first.destination.observation.kind !== "Confirmed") assert.fail("Expected confirmation");
  assert.notEqual(first.source.terms, first.destination.observation.terms);
  assert.notEqual(first.source.acceptedReceipt, first.destination.observation.receipt);
  const expectedSecond = structuredClone(first);
  const second = await observeRecovery({ ...fixture({ state: 2 }).input });
  first.source.accounts.order = "changed";
  first.source.terms.identity.domain.chainId = 1n;
  first.source.terms.cashAmount = 1n;
  assert.ok(first.source.acceptedReceipt);
  first.source.acceptedReceipt.filledQuantity = 1n;
  first.destination.observation.terms.identity.user = b32("01") as typeof first.destination.observation.terms.identity.user;
  first.destination.observation.receipt.filledQuantity = 1n;
  first.destination.observation.inclusion.number = 1n;
  first.destination.transactionHash = b32("01") as typeof first.destination.transactionHash;
  Object.assign(first.plan, { kind: "Wait", reason: "DestinationNotObserved" });
  assert.deepEqual(second, expectedSecond);
  assert.deepEqual(snapshot(f), before);
  assert.equal(first.destination.observation.terms.cashAmount, 10_000_000n, "Source mutation does not alias destination terms");
});

for (const phase of ["source", "discovery"] as const) {
  test(`${phase} deadline propagates without retries or a successful recovery observation`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    if (phase === "source") f.sourceHook(() => { entered(); return new Promise(() => {}); });
    else f.destinationHook((call, response) => {
      if (call.method !== "eth_getLogs") return response;
      entered();
      return new Promise(() => {});
    });
    const rejection = assert.rejects(observeRecovery(f.input), (error) => phase === "source"
      ? error instanceof SourceOrderError && error.code === "RpcTimeout"
      : error instanceof TerminalDiscoveryError && error.code === "RequestDeadline");
    await started;
    const before = structuredClone(f.calls);
    context.mock.timers.tick(10_000);
    await rejection;
    assert.deepEqual(f.calls, before);
    assert.equal(f.sequence.filter((c) => c === "source").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, phase === "source" ? 0 : 1);
  });
}
