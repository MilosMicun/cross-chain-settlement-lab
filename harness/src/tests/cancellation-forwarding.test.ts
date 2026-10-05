import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AbstractSigner, Interface, JsonRpcProvider, Signature, TransactionResponse, getAddress, type TransactionRequest } from "ethers";
import { test } from "node:test";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { ReadFinalizedCancellationRequestInput, SourceOrderConnection, SourceOrderErrorCode } from "../source-order.ts";
import type { ForwardCancellationRequestInput } from "../cancellation-forwarding.ts";
const { forwardCancellationRequest } = await import(new URL("../cancellation-forwarding.ts", import.meta.url).href) as typeof import("../cancellation-forwarding.ts");
const { SourceOrderError } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");

// Public synthetic fixtures only; controlled providers never access the network.
// Independent manual Borsh/SPL layouts and SHA-256 preimages; neither the adapter
// nor protocol-encoding.ts builds expected records, hashes or EVM terms.
const program = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const publicKey = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
const user = publicKey(0x55);
const operator = publicKey(0x81);
const executor = publicKey(0xc1);
const cashMint = publicKey(0x71);
const yesMint = publicKey(0x72);
const U64_MAX = (1n << 64n) - 1n;
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
type FixtureOptions = { nonce?: bigint; cash?: bigint; minimum?: bigint; nextNonce?: bigint; donation?: bigint;
  state?: 0 | 1 | 2 | 3; cancellation?: boolean; receipt?: boolean };
function sourceFixture(options: FixtureOptions = {}) {
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
  const domain = Buffer.concat([raw(shared.sourceDomain), raw(shared.destinationDomain), raw(shared.solanaProgram), uint(31337n, 32), raw(shared.settlement)]);
  const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
  const orderId = hash(identityPreimage);
  const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.toBuffer(), uint(nonce, 8), raw(shared.market), Buffer.from([0]), uint(cash, 8), uint(minimum, 8)]);
  const termsHash = hash(termsPreimage);
  assert.equal(identityPreimage.length, 196);
  assert.equal(termsPreimage.length, 277);
  const configData = Buffer.concat([
    Buffer.from("9b0caae01efacc82", "hex"), Buffer.from([1]), raw(shared.sourceDomain), raw(shared.destinationDomain), program.toBuffer(), uint(31337n, 32),
    ...[shared.settlement, shared.venue, shared.cashToken, shared.yesToken, shared.evmOperator, shared.evmExecutor].map(raw), raw(shared.market), Buffer.from([0]),
    ...[operator, executor, cashMint, yesMint, executorAta, yesAuthority, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId].map((key) => key.toBuffer()),
    Buffer.from([configBump, yesBump]),
  ]);
  assert.equal(configData.length, 580);
  const nonceData = Buffer.concat([Buffer.from("eb8501f3128758e0", "hex"), config.toBuffer(), user.toBuffer(), uint(options.nextNonce ?? nonce + 1n, 8, "le"), Buffer.from([userBump])]);
  const state = options.state ?? 1;
  const hasReceipt = options.receipt ?? state >= 2;
  const terminal = state === 3 ? 2 : 1;
  const quantity = state === 3 ? 0n : cash * 2n;
  const receiptHash = hash(Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([terminal]), uint(quantity, 8)]));
  const orderSerialized = Buffer.concat([
    Buffer.from("86addfb94d561c33", "hex"), config.toBuffer(), user.toBuffer(), uint(nonce, 8, "le"), raw(shared.market), Buffer.from([0]),
    uint(cash, 8, "le"), uint(minimum, 8, "le"), orderId, termsHash, cashAta.toBuffer(), yesAta.toBuffer(), escrow.toBuffer(),
    Buffer.from([state, Number(options.cancellation ?? (state === 1 || state === 3)), Number(hasReceipt)]),
    ...(hasReceipt ? [Buffer.from([terminal]), uint(quantity, 8, "le"), receiptHash] : []), Buffer.from([orderBump, escrowBump]),
  ]);
  const orderData = Buffer.alloc(335);
  orderSerialized.copy(orderData);
  const balance = state >= 2 ? 0n : cash + (options.donation ?? 0n);
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
    evm: { blockNumber: 4, blockHash: "0x" + "ab".repeat(32), rpcChainId: "31337", configuration: { ...shared },
      venue: { cashToken: shared.cashToken, yesToken: shared.yesToken, market: shared.market }, tokenDecimals: { cash: "6", yes: "6" }, codeBytes: {} },
    solana: { contextSlot: 100, minContextSlot: 90, commitment: "finalized", configuration: { ...shared }, config: localConfig,
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
  const input: ReadFinalizedCancellationRequestInput = { connection, expectedConfiguration, user: new PublicKey(user.toBytes()), nonce, minFinalizedSlot: 110 };
  const expectedOutput = { accounts: { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
    userCashAta: cashAta.toBase58(), userYesAta: yesAta.toBase58() }, contextSlot: 123, state: "CancelRequested", cancellationRequested: true, orderId: asHex(orderId), termsHash: asHex(termsHash), escrowBalance: balance,
  terms: { identity: { domain: { sourceDomain: shared.sourceDomain, destinationDomain: shared.destinationDomain, solanaProgram: shared.solanaProgram,
    chainId: 31337n, settlement: shared.settlement }, user: "0x" + "55".repeat(32), nonce }, market: shared.market, outcome: 0, cashAmount: cash, minimumShares: minimum } };
  return { input, records, response, expectedOutput, addresses, orderSerialized, calls: () => calls };
}

const abi = new Interface(JSON.parse(readFileSync(new URL("../../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);
// Independent ABI signature and tuple definition, separate from the compiled ABI.
const independent = new Interface([
  "function cancel(bytes32 orderId, (((bytes32 sourceDomain, bytes32 destinationDomain, bytes32 solanaProgram, uint256 chainId, address settlement) domain, bytes32 user, uint64 nonce) identity, bytes32 market, uint8 outcome, uint64 cashAmount, uint64 minimumShares) terms)",
]);
const transactionHash = "0x" + "ee".repeat(32);
type Operation = "address" | "chain" | "source" | "domain" | "operator" | "send";
type Hook = (operation: Operation, response: unknown) => unknown | Promise<unknown>;
function fixture(options: FixtureOptions = {}) {
  const source = sourceFixture(options);
  const calls: Operation[] = [];
  const submissions: TransactionRequest[] = [];
  let hook: Hook = (_operation, response) => response;
  async function controlled<T>(operation: Operation, response: T): Promise<T> {
    calls.push(operation);
    return await hook(operation, response) as T;
  }
  class ControlledProvider extends JsonRpcProvider {
    constructor() { super("http://network-forbidden.invalid", undefined, { staticNetwork: true }); }
    override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
      assert.equal(method, "eth_chainId", "No receipts, polling, mining or alternate RPC methods");
      assert.deepEqual(params, []);
      return controlled("chain", "0x7a69");
    }
    override async call(tx: TransactionRequest): Promise<string> {
      assert.equal(tx.to, shared.settlement);
      const parsed = abi.parseTransaction({ data: tx.data! }); assert.ok(parsed);
      assert.ok(parsed.name === "domain" || parsed.name === "operator", "No terminal reads or execute fallback");
      assert.equal(parsed.args.length, 0);
      const response = parsed.name === "domain" ? source.expectedOutput.terms.identity.domain : shared.evmOperator;
      return abi.encodeFunctionResult(parsed.name, [await controlled(parsed.name, structuredClone(response))]);
    }
    override async _send(): Promise<never> { assert.fail("Network requests are forbidden"); }
    override async getTransactionReceipt(): Promise<never> { assert.fail("Receipt waiting is forbidden"); }
    override async getTransaction(): Promise<never> { assert.fail("Transaction polling is forbidden"); }
    override async getBlockNumber(): Promise<never> { assert.fail("Block polling is forbidden"); }
    override async broadcastTransaction(): Promise<never> { assert.fail("Alternate broadcast is forbidden"); }
  }
  class ControlledSigner extends AbstractSigner {
    override async getAddress(): Promise<string> { return controlled("address", shared.evmOperator); }
    override async call(tx: TransactionRequest): Promise<string> { return this.provider!.call(tx); }
    override connect(): never { assert.fail("Signer reconnection is forbidden"); }
    override async signTransaction(): Promise<never> { assert.fail("Alternate signing is forbidden"); }
    override async signMessage(): Promise<never> { assert.fail("Message signing is forbidden"); }
    override async signTypedData(): Promise<never> { assert.fail("Typed signing is forbidden"); }
    override async estimateGas(): Promise<never> { assert.fail("Additional transaction methods are forbidden"); }
    override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
      assert.equal(tx.to, shared.settlement);
      assert.deepEqual(Object.keys(tx).sort(), ["data", "to"]);
      assert.equal(abi.parseTransaction({ data: tx.data! })!.name, "cancel");
      submissions.push({ ...tx });
      const response = new TransactionResponse({
        blockNumber: null, blockHash: null, hash: transactionHash, index: 0, type: 0,
        to: String(tx.to), from: shared.evmOperator, nonce: 0, gasLimit: 100_000n,
        gasPrice: 1n, maxPriorityFeePerGas: null, maxFeePerGas: null,
        data: tx.data!, value: 0n, chainId: 31337n, accessList: null, authorizationList: null,
        signature: Signature.from({ r: "0x" + "01".repeat(32), s: "0x" + "02".repeat(32), v: 27 }),
      }, this.provider!);
      response.wait = async () => { assert.fail("Fake response is submission evidence only"); };
      // Never contains terminal evidence, even when cancel could return Filled.
      return controlled("send", response);
    }
  }
  const provider = new ControlledProvider();
  const signer = new ControlledSigner(provider);
  const connection: SourceOrderConnection = new Proxy({
    async getMultipleAccountsInfoAndContext(...args: Parameters<SourceOrderConnection["getMultipleAccountsInfoAndContext"]>) {
      const response = await controlled("source", source.response);
      // The actual reader validates the independently assembled account bytes.
      await source.input.connection.getMultipleAccountsInfoAndContext(...args);
      return response;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "getMultipleAccountsInfoAndContext", "No source writes or other RPC methods");
    return Reflect.get(target, property, receiver);
  } });
  const input: ForwardCancellationRequestInput = { ...source.input, connection, provider, operator: signer };
  return { ...source, input, provider, signer, calls, submissions, hook: (next: Hook) => { hook = next; } };
}
type Fixture = ReturnType<typeof fixture>;
async function rejectSource(f: Fixture, code: SourceOrderErrorCode) {
  await assert.rejects(forwardCancellationRequest(f.input), (error: unknown) => {
    assert.ok(error instanceof SourceOrderError); assert.equal(error.code, code); return true;
  });
  assert.equal(f.submissions.length, 0);
}
function assertSubmission(f: Fixture) {
  assert.equal(f.submissions.length, 1);
  const tx = f.submissions[0];
  assert.equal(tx.to, shared.settlement);
  const decoded = independent.decodeFunctionData("cancel", tx.data!);
  const expected = f.expectedOutput.terms;
  const d = expected.identity.domain;
  assert.deepEqual(decoded.toArray(true), [f.expectedOutput.orderId,
    [[[d.sourceDomain, d.destinationDomain, d.solanaProgram, d.chainId, getAddress(d.settlement)],
      expected.identity.user, expected.identity.nonce], expected.market, 0n, expected.cashAmount, expected.minimumShares]]);
  assert.equal(independent.encodeFunctionData("cancel", decoded), tx.data);
  assert.equal(independent.encodeFunctionData("cancel", [f.expectedOutput.orderId, expected]), tx.data);
}

for (const options of [{}, { nonce: U64_MAX - 1n, cash: U64_MAX / 2n, minimum: U64_MAX }]) {
  test(`one finalized cancellation submission preserves exact observation and full terms (nonce ${options.nonce ?? 7n})`, async () => {
    const f = fixture(options);
    assert.deepEqual(await forwardCancellationRequest(f.input), { sourceRequest: f.expectedOutput, transactionHash });
    assert.deepEqual(f.calls, ["address", "chain", "source", "domain", "operator", "send"]);
    assert.equal(f.calls.filter((call) => call === "source").length, 1);
    assertSubmission(f);
  });
}

test("wrong signer/provider association rejects before all operations", async () => {
  const f = fixture();
  await assert.rejects(forwardCancellationRequest({ ...f.input, operator: new (class extends AbstractSigner {
    async getAddress(): Promise<never> { assert.fail("Must reject before signer read"); }
    connect(): never { assert.fail(); }
    async signTransaction(): Promise<never> { assert.fail(); }
    async signMessage(): Promise<never> { assert.fail(); }
    async signTypedData(): Promise<never> { assert.fail(); }
  })() }), /supplied provider/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.submissions, []);
});
for (const where of ["signer", "evm", "solana"] as const) {
  test(`wrong ${where} operator address rejects without source read or submission`, async () => {
    const f = fixture();
    const wrong = "0x" + "96".repeat(20);
    if (where === "signer") f.hook((operation, response) => operation === "address" ? wrong : response);
    else f.input.expectedConfiguration[where].configuration.evmOperator = wrong;
    await assert.rejects(forwardCancellationRequest(f.input), /configured EVM operator/);
    assert.deepEqual(f.calls, ["address"]); assert.equal(f.submissions.length, 0);
  });
}
test("actual RPC chain ID mismatch stops before source read", async () => {
  const f = fixture(); f.hook((op, response) => op === "chain" ? "0x1" : response);
  await assert.rejects(forwardCancellationRequest(f.input), /actual RPC chain ID 31337/);
  assert.deepEqual(f.calls, ["address", "chain"]); assert.equal(f.submissions.length, 0);
});
for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "chainId", "settlement", "market"] as const) {
  test(`trusted EVM ${field} differs from validated source: zero submissions`, async () => {
    const f = fixture();
    f.input.expectedConfiguration.evm.configuration[field] = field === "chainId" ? "1" : "0x" + "99".repeat(field === "settlement" ? 20 : 32);
    await assert.rejects(forwardCancellationRequest(f.input), /source destination/);
    assert.deepEqual(f.calls, ["address", "chain", "source"]); assert.equal(f.submissions.length, 0);
  });
}
for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "chainId", "settlement"] as const) {
  test(`actual Settlement domain ${field} mismatch: zero submissions`, async () => {
    const f = fixture(); f.hook((op, response) => op === "domain" ? {
      ...response as object, [field]: field === "chainId" ? 1n : "0x" + "99".repeat(field === "settlement" ? 20 : 32),
    } : response);
    await assert.rejects(forwardCancellationRequest(f.input), /Actual Settlement domain/);
    assert.deepEqual(f.calls, ["address", "chain", "source", "domain"]); assert.equal(f.submissions.length, 0);
  });
}
test("actual Settlement operator mismatch: zero submissions", async () => {
  const f = fixture(); f.hook((op, response) => op === "operator" ? "0x" + "99".repeat(20) : response);
  await assert.rejects(forwardCancellationRequest(f.input), /Actual Settlement operator/);
  assert.equal(f.submissions.length, 0);
});
for (const [label, options, code] of [
  ["Pending", { state: 0 }, "NotCancelRequested"],
  ["Settled", { state: 2 }, "NotCancelRequested"],
  ["Refunded", { state: 3 }, "NotCancelRequested"],
  ["missing persisted request flag", { cancellation: false }, "InconsistentCancellationRequest"],
  ["accepted receipt", { receipt: true }, "InconsistentCancellationRequest"],
] satisfies [string, FixtureOptions, SourceOrderErrorCode][]) {
  test(`actual source reader rejects ${label} without submission`, async () => {
    const f = fixture(options); await rejectSource(f, code);
    assert.deepEqual(f.calls, ["address", "chain", "source"]);
  });
}
for (const operation of ["address", "chain", "source", "domain", "operator", "send"] as const) {
  test(`${operation} rejection propagates unchanged, clears timers and never retries`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const scheduled = context.mock.method(globalThis, "setTimeout");
    const clear = context.mock.method(globalThis, "clearTimeout");
    const f = fixture(); const failure = new Error(`Controlled ${operation} failure`);
    f.hook((op, response) => { if (op === operation) throw failure; return response; });
    await assert.rejects(forwardCancellationRequest(f.input), (error) => error === failure);
    assert.equal(f.submissions.length, operation === "send" ? 1 : 0);
    assert.equal(f.calls.filter((op) => op === operation).length, 1);
    assertTimersCleared(scheduled, clear);
    const calls = [...f.calls]; context.mock.timers.tick(60_000); assert.deepEqual(f.calls, calls);
  });
}
// Compare timer handles, including the actual source reader's nested timer.
function assertTimersCleared(scheduled: { mock: { calls: { result: unknown; arguments: unknown[] }[] } },
  clear: { mock: { calls: { arguments: unknown[] }[] } }) {
  const handles = scheduled.mock.calls.map((call) => call.result);
  const cleared = clear.mock.calls.map((call) => call.arguments[0]).filter((handle) => handle !== undefined);
  assert.equal(cleared.length, handles.length);
  for (const handle of handles) assert.equal(cleared.filter((value) => value === handle).length, 1);
  assert.ok(scheduled.mock.calls.every((call) => Number(call.arguments[1]) <= 10_000));
}
for (const operation of ["address", "chain", "source", "domain", "operator", "send"] as const) {
  test(`${operation} timeout at ten seconds clears timers, with no retry or alternate call`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const scheduled = context.mock.method(globalThis, "setTimeout");
    const clear = context.mock.method(globalThis, "clearTimeout");
    const f = fixture(); let signal!: () => void;
    const reached = new Promise<void>((resolve) => { signal = resolve; });
    f.hook((op, response) => { if (op === operation) { signal(); return new Promise(() => {}); } return response; });
    let done = false;
    const assertion = assert.rejects(forwardCancellationRequest(f.input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(/timeout|deadline/.test(error.message));
      done = true; return true;
    });
    await reached;
    context.mock.timers.tick(9_999); await Promise.resolve(); assert.equal(done, false);
    context.mock.timers.tick(1); await assertion;
    assert.equal(f.submissions.length, operation === "send" ? 1 : 0);
    assert.equal(f.calls.filter((op) => op === operation).length, 1);
    assertTimersCleared(scheduled, clear);
    const calls = [...f.calls]; context.mock.timers.tick(60_000); assert.deepEqual(f.calls, calls);
  });
}

test("success clears all timers and makes no later calls", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = context.mock.method(globalThis, "setTimeout");
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture(); await forwardCancellationRequest(f.input);
  assertTimersCleared(scheduled, clear);
  assert.equal(scheduled.mock.calls.length, 7);
  const calls = [...f.calls]; context.mock.timers.tick(60_000); assert.deepEqual(f.calls, calls);
});
test("overall deadline shortens the final send wait to remaining five seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0; let reads = 0;
  context.mock.method(Date, "now", () => { if (++reads === 12) now = 55_000; return now; });
  const scheduled = context.mock.method(globalThis, "setTimeout");
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture(); let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  f.hook((op, response) => {
    if (op === "send") { signal(); return new Promise(() => {}); }
    now += 9_000; return response;
  });
  const assertion = assert.rejects(forwardCancellationRequest(f.input), /cancel submission/);
  await reached; context.mock.timers.tick(4_999); await Promise.resolve();
  context.mock.timers.tick(1); await assertion;
  assert.equal(scheduled.mock.calls.at(-1)!.arguments[1], 5_000);
  assert.equal(f.submissions.length, 1); assertTimersCleared(scheduled, clear);
});
for (const elapsed of [10_000, 60_000]) {
  test(`late successful response at ${elapsed}ms rejects even before timer callback can run`, async (context) => {
    let now = 0; context.mock.method(Date, "now", () => now);
    const f = fixture(); f.hook((op, response) => { if (op === "send") now = elapsed; return response; });
    await assert.rejects(forwardCancellationRequest(f.input), /deadline exceeded: cancel submission/);
    assert.equal(f.submissions.length, 1);
  });
}
test("overall deadline expired between operations forbids submission", async (context) => {
  let reads = 0;
  // start + six operation starts + five completion checks; send begins after expiry.
  context.mock.method(Date, "now", () => ++reads >= 12 ? 60_000 : 0);
  const f = fixture(); await assert.rejects(forwardCancellationRequest(f.input), /deadline exceeded: cancel submission/);
  assert.equal(f.submissions.length, 0);
});
test("snapshots all caller inputs before the first await and returns independent nested data", async () => {
  const f = fixture(); const second = fixture();
  const originalConfig = structuredClone(f.input.expectedConfiguration);
  const recordBytes = f.records.map((record) => Buffer.from(record.data));
  let resolveAddress!: (address: string) => void;
  f.hook((op, response) => op === "address" ? new Promise<string>((resolve) => { resolveAddress = resolve; }) : response);
  const submitted = forwardCancellationRequest(f.input);
  Object.assign(f.input, { user: publicKey(0x56), nonce: 99n, minFinalizedSlot: 999 });
  f.input.expectedConfiguration.evm.configuration.sourceDomain = "0x" + "ff".repeat(32);
  f.input.expectedConfiguration.evm.configuration.evmOperator = "0x" + "ff".repeat(20);
  f.input.expectedConfiguration.solana.configuration.evmOperator = "0x" + "ff".repeat(20);
  f.input.expectedConfiguration.solana.config.dataHex = "ff".repeat(580);
  resolveAddress(shared.evmOperator);
  const first = await submitted;
  const other = await forwardCancellationRequest(second.input);
  assert.deepEqual(first, { sourceRequest: f.expectedOutput, transactionHash }); assertSubmission(f);
  for (const pair of [[first.sourceRequest.accounts, other.sourceRequest.accounts], [first.sourceRequest.terms, other.sourceRequest.terms],
    [first.sourceRequest.terms.identity, other.sourceRequest.terms.identity], [first.sourceRequest.terms.identity.domain, other.sourceRequest.terms.identity.domain]]) {
    assert.notEqual(pair[0], pair[1]);
  }
  first.sourceRequest.terms.cashAmount = 1n;
  first.sourceRequest.terms.identity.domain.chainId = 1n;
  first.sourceRequest.accounts.order = "changed";
  assert.deepEqual(other, { sourceRequest: second.expectedOutput, transactionHash });
  assert.deepEqual(f.records.map((record) => record.data), recordBytes);
  assert.deepEqual(second.input.expectedConfiguration, originalConfig);
  assert.deepEqual(second.input.user.toBytes(), user.toBytes());
});
