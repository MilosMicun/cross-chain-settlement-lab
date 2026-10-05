import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Interface, JsonRpcProvider, toQuantity } from "ethers";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { Bytes32Hex, EvmAddressHex, EvmTerms } from "../source-order.ts";
import type { DiscoverTerminalOutcomeInput, TerminalDiscoveryErrorCode, TerminalDiscoveryRpc } from "../terminal-discovery.ts";
const { discoverTerminalOutcome, TerminalDiscoveryError } = await import(new URL("../terminal-discovery.ts", import.meta.url).href) as typeof import("../terminal-discovery.ts");
const { TerminalObservationError } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const abi = new Interface(JSON.parse(readFileSync(new URL("../../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);
const b32 = (byte: string) => `0x${byte.repeat(32)}` as Bytes32Hex;
const a20 = (byte: string) => `0x${byte.repeat(20)}` as EvmAddressHex;
const U64_MAX = (1n << 64n) - 1n;
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const sha = (value: Uint8Array) => `0x${createHash("sha256").update(value).digest("hex")}` as Bytes32Hex;
const uint = (value: bigint, width: number) => Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
const receiptDigest = (hash: string, terminal: number, quantity: bigint) => sha(Buffer.concat([
  Buffer.from("CCSLRC01"), raw(hash), Buffer.from([terminal]), uint(quantity, 8),
]));
type Call = { method: Parameters<TerminalDiscoveryRpc["send"]>[0]; params: unknown[]; occurrence: number };

function fixture(options: { terminal?: 1 | 2; method?: "execute" | "cancel"; nonce?: bigint; user?: Bytes32Hex;
  cash?: bigint; minimum?: bigint; inclusion?: bigint; additional?: bigint } = {}) {
  const terminal = options.terminal ?? 1;
  const method = options.method ?? (terminal === 1 ? "execute" : "cancel");
  const terms: EvmTerms = { identity: { domain: { sourceDomain: b32("11"), destinationDomain: b32("22"),
    solanaProgram: b32("33"), chainId: 31337n, settlement: a20("44") }, user: options.user ?? b32("55"), nonce: options.nonce ?? 7n },
  market: b32("66"), outcome: 0, cashAmount: options.cash ?? 10_000_000n, minimumShares: options.minimum ?? 20_000_000n };
  const d = terms.identity.domain;
  // Independently construct SPEC preimages; do not use production encoders.
  const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
  const id = sha(Buffer.concat([Buffer.from("CCSLID01"), domain, raw(terms.identity.user), uint(terms.identity.nonce, 8)]));
  const hash = sha(Buffer.concat([Buffer.from("CCSLTR01"), domain, raw(id), raw(terms.identity.user), uint(terms.identity.nonce, 8),
    raw(terms.market), Buffer.from([0]), uint(terms.cashAmount, 8), uint(terms.minimumShares, 8)]));
  const content = { termsHash: hash, terminal, filledQuantity: terminal === 1 ? 2n * terms.cashAmount : 0n };
  const receiptHash = receiptDigest(hash, terminal, content.filledQuantity);
  const shared: SharedConfiguration = { ...d, chainId: "31337", market: terms.market, venue: a20("77"), cashToken: a20("88"),
    yesToken: a20("99"), evmOperator: a20("aa"), evmExecutor: a20("bb") };
  const expectedConfiguration: LiveConfigurationObservation = {
    scope: "Controlled offline RPC fixture, not live deployment evidence",
    evm: { blockNumber: 4, blockHash: b32("ab"), rpcChainId: "31337", configuration: { ...shared },
      venue: { cashToken: shared.cashToken, yesToken: shared.yesToken, market: shared.market }, tokenDecimals: { cash: "6", yes: "6" }, codeBytes: {} },
    solana: { contextSlot: 123, minContextSlot: 100, commitment: "finalized", configuration: { ...shared },
      config: { address: "fixture", owner: "fixture", dataHex: "", version: 1, outcome: 0, bump: 0, yesAuthorityBump: 0,
        operator: "fixture", executor: "fixture", cashMint: "fixture", yesMint: "fixture", executorCashAta: "fixture", yesAuthority: "fixture",
        tokenProgram: "fixture", associatedTokenProgram: "fixture", systemProgram: "fixture" },
      accounting: { address: "fixture", owner: "fixture", config: "fixture", bump: 0, counters: ["0", "0", "0", "0"] },
      mints: { cash: { address: "fixture", owner: "fixture", decimals: 6, authority: "fixture", freezeAuthority: null, supply: "0" },
        yes: { address: "fixture", owner: "fixture", decimals: 6, authority: "fixture", freezeAuthority: null, supply: "0" } },
      executorCashAta: { address: "fixture", owner: "fixture", mint: "fixture", amount: "0" },
      program: { address: "fixture", owner: "fixture", executable: true, programData: "fixture", programDataOwner: "fixture",
        deploymentSlot: "1", upgradeAuthority: null, loadedImageSha256: "" } },
  };
  const inclusion = { number: options.inclusion ?? 10n, hash: b32("cc") };
  const head = { number: inclusion.number + (options.additional ?? 2n), hash: b32("dd") };
  const range = { fromBlock: inclusion.number > 10n ? inclusion.number - 10n : 0n, toBlock: inclusion.number + 2n };
  const rangeAnchor = { number: range.toBlock, hash: head.hash };
  const transactionHash = b32("ee");
  const encoded = abi.encodeEventLog(abi.getEvent("TerminalRecorded")!, [id, hash, terminal, content.filledQuantity, receiptHash]);
  const log = { address: shared.settlement, topics: encoded.topics, data: encoded.data, transactionHash,
    blockHash: inclusion.hash, blockNumber: toQuantity(inclusion.number), transactionIndex: "0x0", logIndex: "0x3", removed: false };
  const logs: unknown[] = [log];
  const receipt = { transactionHash, status: "0x1", from: shared.evmOperator, to: shared.settlement,
    blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: "0x0", logs: [structuredClone(log)] as unknown[] };
  const transaction = { hash: transactionHash, from: shared.evmOperator, to: shared.settlement, chainId: "0x7a69", value: "0x0",
    blockNumber: log.blockNumber, blockHash: log.blockHash, transactionIndex: "0x0", input: abi.encodeFunctionData(method, [id, terms]) };
  const record = { terms: structuredClone(terms), termsHash: hash, status: BigInt(terminal), filledQuantity: content.filledQuantity, receiptHash };
  const calls: Call[] = [];
  let hook: ((call: Call, response: unknown, params: unknown[]) => unknown | Promise<unknown>) | undefined;
  const provider: TerminalDiscoveryRpc = new Proxy({
    async send(method: Call["method"], params: unknown[]): Promise<unknown> {
      const call: Call = { method, params: structuredClone(params), occurrence: calls.filter((c) => c.method === method).length + 1 };
      calls.push(call);
      let response: unknown;
      switch (method) {
        case "eth_chainId": assert.deepEqual(params, []); response = "0x7a69"; break;
        case "eth_getLogs": response = logs; break;
        case "eth_getTransactionReceipt": assert.deepEqual(params, [transactionHash]); response = receipt; break;
        case "eth_getTransactionByHash": assert.deepEqual(params, [transactionHash]); response = transaction; break;
        case "eth_getBlockByNumber": {
          assert.equal(params[1], false);
          const selected = params[0] === "latest" ? head : params[0] === toQuantity(rangeAnchor.number) ? rangeAnchor
            : { number: BigInt(params[0] as string), hash: inclusion.hash };
          response = { number: toQuantity(selected.number), hash: selected.hash }; break;
        }
        case "eth_call": {
          const request = params[0] as { to: string; data: string };
          const tag = params[1] as { blockHash: string; requireCanonical: boolean };
          assert.equal(request.to, shared.settlement);
          assert.deepEqual(Object.keys(tag).sort(), ["blockHash", "requireCanonical"]);
          assert.equal(tag.requireCanonical, true);
          const parsed = abi.parseTransaction({ data: request.data }); assert.ok(parsed);
          assert.ok(["domain", "operator", "orderRecord"].includes(parsed.name));
          if (parsed.name === "orderRecord") assert.equal(parsed.args[0], id);
          response = abi.encodeFunctionResult(parsed.name, [parsed.name === "domain" ? d : parsed.name === "operator" ? shared.evmOperator : record]);
          break;
        }
        default: assert.fail(`Forbidden RPC or write: ${String(method)}`);
      }
      // Intentionally return provider-owned data to exercise evidence ownership.
      return hook ? hook(call, response, params) : response;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "send", `Unexpected provider capability: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  const input: DiscoverTerminalOutcomeInput = { provider, expectedConfiguration, orderId: id, termsHash: hash, terms: structuredClone(terms), ...range };
  const output = { kind: "Observed", transactionHash, observation: { kind: "Confirmed", orderId: id, termsHash: hash,
    terms: structuredClone(terms), receipt: content, receiptHash, transactionHash, inclusion, observationHead: head,
    additionalBlocks: head.number - inclusion.number } };
  return { input, output, logs, log, receipt, transaction, record, inclusion, head, rangeAnchor, calls,
    hook: (value: typeof hook) => { hook = value; } };
}
type Fixture = ReturnType<typeof fixture>;
async function rejects(f: Fixture, code: TerminalDiscoveryErrorCode) {
  await assert.rejects(discoverTerminalOutcome(f.input), (error: unknown) => {
    assert.ok(error instanceof TerminalDiscoveryError); assert.equal(error.code, code, error.message); return true;
  });
}
const getter = (call: Call) => call.method === "eth_call" ? abi.parseTransaction({ data: (call.params[0] as { data: string }).data })!.name : "";
const isAnchor = (f: Fixture, call: Call) => call.method === "eth_getBlockByNumber" && call.params[0] === toQuantity(f.rangeAnchor.number);

for (const terminal of [1, 2] as const) {
  test(`rediscovers original ${terminal === 1 ? "Filled" : "Cancelled"} and confirms using actual observer at N+2`, async () => {
    const f = fixture({ terminal });
    assert.equal(f.input.orderId, "0xbd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7");
    assert.equal(f.input.termsHash, "0x081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8");
    assert.equal(f.record.receiptHash, terminal === 1 ? "0xbeb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888"
      : "0xacc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b");
    assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
    const searches = f.calls.filter((c) => c.method === "eth_getLogs"); assert.equal(searches.length, 1);
    assert.deepEqual(searches[0].params, [{ address: a20("44"), fromBlock: "0x0", toBlock: "0xc",
      topics: [abi.getEvent("TerminalRecorded")!.topicHash, f.input.orderId] }]);
    assert.equal((searches[0].params[0] as { topics: string[] }).topics.length, 2, "No termsHash filter");
    assert.deepEqual(f.calls.slice(0, 5).map((c) => c.method), ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs",
      "eth_getTransactionReceipt", "eth_chainId"]);
    assert.ok(isAnchor(f, f.calls.at(-1)!));
    assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 6, "Actual observer checks inclusion and head storage");
  });
}
test("empty bounded search rechecks anchor and reports only NotFound", async () => {
  const f = fixture(); f.logs.length = 0;
  assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "NotFound", searched: { fromBlock: 0n, toBlock: 12n } });
  assert.deepEqual(f.calls.map((c) => c.method), ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getBlockByNumber"]);
});
test("replay emits no new event; bounded search still recovers original creating transaction", async () => {
  const f = fixture(); const replayHash = b32("fa");
  const replayReceipt = { ...structuredClone(f.receipt), transactionHash: replayHash, logs: [] };
  assert.deepEqual(replayReceipt.logs, []);
  const first = await discoverTerminalOutcome(f.input);
  const second = await discoverTerminalOutcome(f.input);
  assert.deepEqual(first, f.output); assert.deepEqual(second, first); assert.equal(f.logs.length, 1);
  assert.ok(f.calls.filter((c) => c.method === "eth_getTransactionReceipt").every((c) => c.params[0] === f.log.transactionHash));
  assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, 2, "One search per explicit attempt");
});
test("range containing only an eventless replay returns a bounded negative result", async () => {
  const f = fixture(); Object.assign(f.input, { fromBlock: 11n, toBlock: 12n }); f.logs.length = 0;
  assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "NotFound", searched: { fromBlock: 11n, toBlock: 12n } });
});
for (const [label, options] of [["full-width block precision", { inclusion: 9_007_199_254_740_993n }],
  ["maximum protocol amounts", { nonce: U64_MAX - 1n, cash: U64_MAX / 2n, minimum: U64_MAX - 1n }],
  ["cancelled unattainable minimum", { terminal: 2 as const, cash: 1n, minimum: U64_MAX }]] as const) {
  test(label, async () => { const f = fixture(options); assert.deepEqual(await discoverTerminalOutcome(f.input), f.output); });
}
for (const [label, alter, reason] of [
  ["missing observer receipt", (c: Call) => c.method === "eth_getTransactionReceipt" && c.occurrence === 2, "MissingReceipt"],
  ["missing observer transaction", (c: Call) => c.method === "eth_getTransactionByHash", "MissingTransaction"],
  ["missing observer head", (c: Call) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest", "CanonicalEvidenceUnavailable"],
  ["missing observer inclusion", (c: Call) => c.method === "eth_getBlockByNumber" && c.params[0] === "0xa", "CanonicalEvidenceUnavailable"],
  ["missing observer rechecked receipt", (c: Call) => c.method === "eth_getTransactionReceipt" && c.occurrence === 3, "CanonicalEvidenceUnavailable"],
] as const) {
  test(`preserves NotConfirmed: ${label}`, async () => {
    const f = fixture(); f.hook((c, response) => alter(c) ? null : response);
    assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "Observed", transactionHash: f.log.transactionHash,
      observation: { kind: "NotConfirmed", reason } });
    assert.ok(isAnchor(f, f.calls.at(-1)!));
  });
}
test("preserves observer insufficient additional blocks", async () => {
  const f = fixture({ additional: 1n });
  assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "Observed", transactionHash: f.log.transactionHash,
    observation: { kind: "NotConfirmed", reason: "InsufficientAdditionalBlocks" } });
});
test("preserves observer canonical evidence changed without treating it as NotFound", async () => {
  const f = fixture(); f.hook((c, response) => c.method === "eth_getBlockByNumber" && c.params[0] === "0xa"
    ? { ...(response as object), hash: b32("01") } : response);
  assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "Observed", transactionHash: f.log.transactionHash,
    observation: { kind: "NotConfirmed", reason: "CanonicalEvidenceChanged" } });
});

const logMutations: [string, (f: Fixture) => void, TerminalDiscoveryErrorCode][] = [
  ["wrong emitter", (f) => { f.log.address = a20("01"); }, "BindingMismatch"],
  ["malformed emitter", (f) => { f.log.address = "0x01"; }, "MalformedEvidence"],
  ["wrong signature", (f) => { f.log.topics[0] = b32("01"); }, "MalformedEvidence"],
  ["wrong order", (f) => { f.log.topics[1] = b32("01"); }, "BindingMismatch"],
  ["conflicting terms", (f) => { f.log.topics[2] = b32("01"); }, "BindingMismatch"],
  ["short topic", (f) => { f.log.topics[1] = "0x01"; }, "MalformedEvidence"],
  ["missing topic", (f) => { f.log.topics.pop(); }, "MalformedEvidence"],
  ["extra topic", (f) => { f.log.topics.push(b32("01")); }, "MalformedEvidence"],
  ["non-array topics", (f) => { Object.assign(f.log, { topics: {} }); }, "MalformedEvidence"],
  ["malformed data", (f) => { f.log.data = "0xzz"; }, "MalformedEvidence"],
  ["missing ABI words", (f) => { f.log.data = "0x01"; }, "MalformedEvidence"],
  ["trailing bytes", (f) => { f.log.data += "00"; }, "MalformedEvidence"],
  ["trailing ABI word", (f) => { f.log.data += "00".repeat(32); }, "MalformedEvidence"],
  ["noncanonical uint8 padding", (f) => { f.log.data = "0x01" + f.log.data.slice(4); }, "MalformedEvidence"],
  ["noncanonical uint64 padding", (f) => { f.log.data = f.log.data.slice(0, 66) + "01" + f.log.data.slice(68); }, "MalformedEvidence"],
  ["removed", (f) => { f.log.removed = true; }, "MalformedEvidence"],
  ["missing removed flag", (f) => { Object.assign(f.log, { removed: undefined }); }, "MalformedEvidence"],
  ["zero transaction hash", (f) => { f.log.transactionHash = b32("00"); }, "MalformedEvidence"],
  ["zero block hash", (f) => { f.log.blockHash = b32("00"); }, "MalformedEvidence"],
  ["short transaction hash", (f) => { Object.assign(f.log, { transactionHash: "0x01" }); }, "MalformedEvidence"],
  ["short block hash", (f) => { Object.assign(f.log, { blockHash: "0x01" }); }, "MalformedEvidence"],
  ["block above range", (f) => { f.log.blockNumber = "0xd"; }, "MalformedEvidence"],
  ["block below range", (f) => { Object.assign(f.input, { fromBlock: 11n }); }, "MalformedEvidence"],
];
for (const [label, mutate, code] of logMutations) {
  test(`rejects candidate ${label}`, async () => {
    const f = fixture(); mutate(f); await rejects(f, code);
    assert.equal(f.calls.filter((c) => c.method === "eth_getTransactionReceipt").length, 0);
  });
}
for (const field of ["blockNumber", "transactionIndex", "logIndex"] as const) {
  for (const value of ["0x00", "-0x1", "0x", "0xgg", toQuantity(1n << 256n), 10, null]) {
    test(`rejects noncanonical candidate ${field}: ${String(value)}`, async () => {
      const f = fixture(); Object.assign(f.log, { [field]: value }); await rejects(f, "MalformedEvidence");
    });
  }
}
for (const [terminal, quantity] of [[0, 0n], [3, 0n], [1, 0n], [1, 19_999_999n], [1, 20_000_001n], [2, 1n]] as const) {
  test(`coherent event hash cannot bypass terminal=${terminal}, quantity=${quantity} policy`, async () => {
    const f = fixture();
    Object.assign(f.log, abi.encodeEventLog(abi.getEvent("TerminalRecorded")!, [f.input.orderId, f.input.termsHash, terminal,
      quantity, receiptDigest(f.input.termsHash, terminal, quantity)]));
    await rejects(f, "MalformedEvidence");
  });
}
test("exact full fill below minimum is rejected even with coherent terms and receipt hashes", async () => {
  const f = fixture({ minimum: 20_000_001n }); await rejects(f, "MalformedEvidence");
});
test("noncanonical receipt digest is rejected", async () => {
  const f = fixture(); Object.assign(f.log, abi.encodeEventLog(abi.getEvent("TerminalRecorded")!, [f.input.orderId,
    f.input.termsHash, 1, f.record.filledQuantity, b32("01")])); await rejects(f, "MalformedEvidence");
});
for (const response of [null, undefined, {}, "logs", [null], [[]]]) {
  test(`malformed log response ${JSON.stringify(response)} fails closed`, async () => {
    const f = fixture(); f.hook((c, value) => c.method === "eth_getLogs" ? response : value); await rejects(f, "MalformedEvidence");
  });
}
test("sparse returned log arrays cannot bypass candidate validation", async () => {
  const f = fixture(); f.hook((c, response) => c.method === "eth_getLogs" ? new Array(1) : response);
  await rejects(f, "MalformedEvidence");
});
test("sparse topics cannot bypass canonical topic validation", async () => {
  const f = fixture(); delete f.log.topics[2]; await rejects(f, "MalformedEvidence");
});
for (const duplicate of [true, false]) {
  test(`${duplicate ? "duplicate entries" : "multiple distinct candidates"} are ambiguous`, async () => {
    const f = fixture(); f.logs.push({ ...structuredClone(f.log), ...(duplicate ? {} : { transactionHash: b32("01"), logIndex: "0x4" }) });
    await rejects(f, "AmbiguousCandidates"); assert.equal(f.calls.length, 3);
  });
}
test("malformed second candidate is not ignored in an ambiguous response", async () => {
  const f = fixture(); f.logs.push({ ...structuredClone(f.log), removed: true }); await rejects(f, "MalformedEvidence");
});
test("conflicting second candidate is not hidden by termsHash filtering", async () => {
  const f = fixture(); const second = structuredClone(f.log); second.topics[2] = b32("01"); f.logs.push(second);
  await rejects(f, "BindingMismatch");
});

for (const [label, mutate, code] of [
  ["failed", (f: Fixture) => { f.receipt.status = "0x0"; }, "MalformedEvidence"],
  ["invalid status", (f: Fixture) => { f.receipt.status = "0x2"; }, "MalformedEvidence"],
  ["wrong transaction", (f: Fixture) => { f.receipt.transactionHash = b32("01"); }, "BindingMismatch"],
  ["wrong block hash", (f: Fixture) => { f.receipt.blockHash = b32("01"); }, "BindingMismatch"],
  ["wrong block number", (f: Fixture) => { f.receipt.blockNumber = "0xb"; }, "BindingMismatch"],
  ["wrong transaction index", (f: Fixture) => { f.receipt.transactionIndex = "0x1"; }, "BindingMismatch"],
  ["padded transaction index", (f: Fixture) => { f.receipt.transactionIndex = "0x00"; }, "MalformedEvidence"],
  ["missing event", (f: Fixture) => { f.receipt.logs = []; }, "MalformedEvidence"],
  ["duplicate event", (f: Fixture) => { f.receipt.logs.push(structuredClone(f.log)); }, "MalformedEvidence"],
  ["malformed logs", (f: Fixture) => { Object.assign(f.receipt, { logs: null }); }, "MalformedEvidence"],
  ["malformed log entry", (f: Fixture) => { f.receipt.logs = [null]; }, "MalformedEvidence"],
] as const) {
  test(`rejects discovered receipt ${label}`, async () => {
    const f = fixture(); mutate(f); await rejects(f, code); assert.equal(f.calls.length, 4, "Observer has not been called");
  });
}
for (const value of [null, [], undefined, "receipt"]) {
  test(`unavailable/malformed discovered receipt ${String(value)}`, async () => {
    const f = fixture(); f.hook((c, response) => c.method === "eth_getTransactionReceipt" ? value : response);
    await rejects(f, value === null ? "HistoryUnavailable" : "MalformedEvidence");
  });
}
for (const [field, value, code] of [
  ["address", a20("01"), "MalformedEvidence"], ["data", "0x", "MalformedEvidence"],
  ["topics", [b32("01")], "MalformedEvidence"], ["transactionHash", b32("01"), "BindingMismatch"],
  ["blockHash", b32("01"), "BindingMismatch"], ["blockNumber", "0xb", "BindingMismatch"],
  ["transactionIndex", "0x1", "BindingMismatch"], ["logIndex", "0x4", "BindingMismatch"], ["removed", true, "MalformedEvidence"],
] as const) {
  test(`receipt event must exactly match candidate ${field}`, async () => {
    const f = fixture(); Object.assign(f.receipt.logs[0] as object, { [field]: value }); await rejects(f, code);
  });
}
test("unrelated token receipt logs are allowed alongside the exact terminal event", async () => {
  const f = fixture(); f.receipt.logs.unshift({ address: a20("88"), topics: [b32("01")], data: "0x" });
  assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
});
test("confirmed observer inclusion must match the candidate inclusion", async () => {
  const f = fixture();
  f.hook((c, response) => c.method === "eth_getTransactionReceipt" && c.occurrence >= 2 || c.method === "eth_getTransactionByHash"
    ? { ...(response as object), blockNumber: "0x9" } : response);
  await rejects(f, "BindingMismatch"); assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 6);
});
test("confirmed observer terminal receipt must match the candidate event", async () => {
  const f = fixture({ method: "cancel" });
  f.record.status = 2n; f.record.filledQuantity = 0n; f.record.receiptHash = receiptDigest(f.input.termsHash, 2, 0n);
  await rejects(f, "BindingMismatch"); assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 6);
});
for (const [label, hook, code] of [
  ["failed observer receipt", (c: Call, v: unknown) => c.method === "eth_getTransactionReceipt" && c.occurrence === 2
    ? { ...(v as object), status: "0x0" } : v, "FailedTransaction"],
  ["conflicting observer storage", (c: Call, v: unknown) => getter(c) === "orderRecord" ? "0x01" : v, "MalformedEvidence"],
  ["wrong observer destination", (c: Call, v: unknown) => c.method === "eth_getTransactionByHash" ? { ...(v as object), to: a20("01") } : v, "BindingMismatch"],
] as const) {
  test(`observer error propagates unchanged: ${label}`, async () => {
    const f = fixture(); f.hook(hook);
    await assert.rejects(discoverTerminalOutcome(f.input), (error: unknown) => {
      assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, code); return true;
    });
    assert.equal(f.calls.filter((c) => c.method === "eth_getLogs").length, 1);
  });
}

for (const empty of [true, false]) {
  for (const changed of ["missing", "hash", "number"] as const) {
    test(`${empty ? "NotFound" : "Observed"} cannot escape ${changed} range anchor on final recheck`, async () => {
      const f = fixture(); if (empty) f.logs.length = 0;
      let anchors = 0;
      f.hook((c, response) => {
        if (isAnchor(f, c) && ++anchors === (empty ? 2 : 3)) {
          return changed === "missing" ? null : { ...(response as object), [changed]: changed === "hash" ? b32("01") : "0xd" };
        }
        return response;
      });
      await rejects(f, changed === "missing" ? "HistoryUnavailable" : "HistoryChanged");
    });
  }
}
for (const [label, response, code] of [["unavailable", null, "HistoryUnavailable"], ["wrong number", { number: "0xd", hash: b32("dd") }, "HistoryChanged"],
  ["padded number", { number: "0x0c", hash: b32("dd") }, "MalformedEvidence"], ["zero hash", { number: "0xc", hash: b32("00") }, "MalformedEvidence"],
  ["malformed object", [], "MalformedEvidence"], ["short hash", { number: "0xc", hash: "0x01" }, "MalformedEvidence"]] as const) {
  test(`initial search anchor ${label} prevents log search`, async () => {
    const f = fixture(); f.hook((c, value) => isAnchor(f, c) ? response : value); await rejects(f, code); assert.equal(f.calls.length, 2);
  });
}
for (const [fromBlock, toBlock] of [[-1n, 1n], [2n, 1n], [0n, 2_048n], [0n, 1n << 256n],
  [1n << 256n, 1n << 256n], [0, 12n], [0n, "latest"], [undefined, 12n]]) {
  test(`invalid range ${String(fromBlock)}..${String(toBlock)} rejects before RPC`, async () => {
    const f = fixture(); Object.assign(f.input, { fromBlock, toBlock }); await rejects(f, "InvalidRange"); assert.equal(f.calls.length, 0);
  });
}
for (const [fromBlock, toBlock] of [[0n, 0n], [0n, 2_047n], [(1n << 256n) - 1n, (1n << 256n) - 1n]]) {
  test(`valid range boundary ${fromBlock}..${toBlock} is not truncated or widened`, async () => {
    const f = fixture(); Object.assign(f.input, { fromBlock, toBlock }); f.logs.length = 0;
    f.hook((c, response) => c.method === "eth_getBlockByNumber" ? { number: toQuantity(toBlock), hash: b32("dd") } : response);
    assert.deepEqual(await discoverTerminalOutcome(f.input), { kind: "NotFound", searched: { fromBlock, toBlock } });
    assert.deepEqual(f.calls[2].params, [{ address: a20("44"), fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock),
      topics: [abi.getEvent("TerminalRecorded")!.topicHash, f.input.orderId] }]);
  });
}
const inputMutations: [string, (f: Fixture) => void, TerminalDiscoveryErrorCode][] = [
  ["missing provider", (f) => { Object.assign(f.input, { provider: {} }); }, "InvalidInput"],
  ["malformed order", (f) => { Object.assign(f.input, { orderId: "0x01" }); }, "InvalidInput"],
  ["noncanonical order", (f) => { Object.assign(f.input, { orderId: b32("01") }); }, "InvalidInput"],
  ["noncanonical terms hash", (f) => { Object.assign(f.input, { termsHash: b32("01") }); }, "InvalidInput"],
  ["missing terms", (f) => { Object.assign(f.input, { terms: {} }); }, "InvalidInput"],
  ["negative nonce", (f) => { f.input.terms.identity.nonce = -1n; }, "InvalidInput"],
  ["nonce over uint64", (f) => { f.input.terms.identity.nonce = U64_MAX + 1n; }, "InvalidInput"],
  ["number cash", (f) => { Object.assign(f.input.terms, { cashAmount: 10_000_000 }); }, "InvalidInput"],
  ["minimum over uint64", (f) => { f.input.terms.minimumShares = U64_MAX + 1n; }, "InvalidInput"],
  ["chain over uint256", (f) => { f.input.terms.identity.domain.chainId = 1n << 256n; }, "InvalidInput"],
  ["non-YES outcome", (f) => { Object.assign(f.input.terms, { outcome: 1 }); }, "InvalidInput"],
  ["bad terms address checksum", (f) => { f.input.terms.identity.domain.settlement = "0xAa00000000000000000000000000000000000000" as EvmAddressHex; }, "InvalidInput"],
  ["shared operator disagreement", (f) => { f.input.expectedConfiguration.solana.configuration.evmOperator = a20("01"); }, "BindingMismatch"],
  ["trusted chain", (f) => { f.input.expectedConfiguration.evm.configuration.chainId = "1"; }, "BindingMismatch"],
  ["trusted RPC chain", (f) => { f.input.expectedConfiguration.evm.rpcChainId = "1"; }, "BindingMismatch"],
  ["trusted byte width", (f) => { f.input.expectedConfiguration.evm.configuration.sourceDomain = "0x01"; }, "InvalidInput"],
  ["trusted zero binding", (f) => { f.input.expectedConfiguration.evm.configuration.evmOperator = a20("00"); }, "InvalidInput"],
];
for (const [label, mutate, code] of inputMutations) {
  test(`invalid input ${label} fails before RPC`, async () => {
    const f = fixture(); mutate(f); await rejects(f, code); assert.equal(f.calls.length, 0);
  });
}
test("null input has a typed validation failure", async () => {
  await assert.rejects(discoverTerminalOutcome(null as unknown as DiscoverTerminalOutcomeInput), (error: unknown) => {
    assert.ok(error instanceof TerminalDiscoveryError); assert.equal(error.code, "InvalidInput"); return true;
  });
});
for (const [label, options] of [["reserved nonce", { nonce: U64_MAX }], ["zero user", { user: b32("00") }], ["zero cash", { cash: 0n }],
  ["cash above full-fill bound", { terminal: 2 as const, cash: U64_MAX / 2n + 1n }], ["zero minimum", { minimum: 0n }]] as const) {
  test(`coherent input hashes cannot bypass ${label}`, async () => {
    const f = fixture(options); await rejects(f, "InvalidInput"); assert.equal(f.calls.length, 0);
  });
}
for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "settlement", "market"] as const) {
  test(`complete terms must bind both trusted configurations: ${field}`, async () => {
    const f = fixture();
    for (const config of [f.input.expectedConfiguration.evm.configuration, f.input.expectedConfiguration.solana.configuration]) {
      config[field] = field === "settlement" ? a20("01") : b32("01");
    }
    await rejects(f, "BindingMismatch"); assert.equal(f.calls.length, 0);
  });
}
for (const value of ["0x1", "0x07a69", "0x", 31337]) {
  test(`actual chain ID ${value} fails before history reads`, async () => {
    const f = fixture(); f.hook(() => value); await rejects(f, value === "0x1" ? "BindingMismatch" : "MalformedEvidence");
    assert.equal(f.calls.length, 1);
  });
}
for (const method of ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call"] as const) {
  test(`RPC failure in ${method} is typed and never retried`, async () => {
    const f = fixture(); const cause = new Error("Controlled RPC failure");
    f.hook((c, response) => { if (c.method === method) throw cause; return response; });
    await assert.rejects(discoverTerminalOutcome(f.input), (error: unknown) => {
      assert.ok(error instanceof TerminalDiscoveryError); assert.equal(error.code, "RpcFailure"); assert.equal(error.cause, cause); return true;
    });
    assert.equal(f.calls.at(-1)!.method, method); assert.equal(f.calls.filter((c) => c.method === method).length, 1);
  });
}
test("synchronous provider rejection is typed and clears its timer", async (context) => {
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture(); Object.assign(f.input, { provider: { send() { throw new Error("Synchronous RPC failure"); } } });
  await rejects(f, "RpcFailure"); assert.equal(clear.mock.callCount(), 1);
});
for (const method of ["eth_getLogs", "eth_getTransactionByHash"] as const) {
  test(`hung ${method} is bounded by ten seconds, including observer reads`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const clear = context.mock.method(globalThis, "clearTimeout");
    const f = fixture(); let signal!: () => void;
    const reached = new Promise<void>((resolve) => { signal = resolve; });
    f.hook((c, response) => { if (c.method === method) { signal(); return new Promise(() => {}); } return response; });
    const pending = discoverTerminalOutcome(f.input);
    const assertion = assert.rejects(pending, (error: unknown) => {
      // The existing observer also enforces ten seconds. If its own timer wins
      // the race, preserve its error rather than reinterpret it as discovery.
      assert.ok(error instanceof TerminalDiscoveryError || error instanceof TerminalObservationError);
      assert.equal(error.code, "RequestDeadline"); return true;
    });
    await reached; let settled = false; void pending.catch(() => { settled = true; });
    context.mock.timers.tick(9_999); await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await assertion;
    assert.equal(f.calls.at(-1)!.method, method);
    assert.ok(clear.mock.callCount() >= f.calls.length);
  });
}
test("observer inherits remaining overall budget for a hung read", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0; context.mock.method(Date, "now", () => now);
  const f = fixture(); let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  f.hook((_c, response) => { if (f.calls.length === 7) { signal(); return new Promise(() => {}); } now += 9_000; return response; });
  const pending = discoverTerminalOutcome(f.input);
  const assertion = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof TerminalDiscoveryError); assert.equal(error.code, "OverallDeadline"); return true;
  });
  await reached; context.mock.timers.tick(6_000); await assertion; assert.equal(f.calls.length, 7);
});
test("elapsed overall time is checked after observer RPC resolution", async (context) => {
  let now = 0; context.mock.method(Date, "now", () => now);
  const f = fixture(); f.hook((_c, response) => { now += 9_000; return response; });
  await rejects(f, "OverallDeadline"); assert.equal(f.calls.length, 7);
});
for (const method of ["eth_getLogs", "eth_getTransactionByHash"] as const) {
  test(`elapsed request time is checked after late ${method} resolution`, async (context) => {
    let now = 0; context.mock.method(Date, "now", () => now);
    const f = fixture(); f.hook((c, response) => { if (c.method === method) now += 10_000; return response; });
    await rejects(f, "RequestDeadline"); assert.equal(f.calls.at(-1)!.method, method);
  });
}
test("success, NotFound and validation failures clear all created deadline timers", async (context) => {
  const scheduled = context.mock.method(globalThis, "setTimeout");
  const cleared = context.mock.method(globalThis, "clearTimeout");
  const success = fixture(); assert.deepEqual(await discoverTerminalOutcome(success.input), success.output);
  const empty = fixture(); empty.logs.length = 0; await discoverTerminalOutcome(empty.input);
  const failure = fixture(); failure.receipt.logs = []; await rejects(failure, "MalformedEvidence");
  const observerFailure = fixture(); observerFailure.record.status = 0n;
  await assert.rejects(discoverTerminalOutcome(observerFailure.input), TerminalObservationError);
  assert.equal(cleared.mock.callCount(), scheduled.mock.callCount());
  const handles = scheduled.mock.calls.map((c) => c.result);
  assert.deepEqual(cleared.mock.calls.map((c) => c.arguments[0]).sort(), handles.sort(), "Every timer cleared, not just the same count");
});
test("caller mutations and provider method replacement cannot change the snapshotted attempt", async () => {
  const f = fixture();
  f.hook((c, response) => {
    if (c.method === "eth_chainId" && c.occurrence === 1) {
      f.input.terms.identity.domain.sourceDomain = b32("01"); f.input.terms.cashAmount = 1n;
      f.input.expectedConfiguration.evm.configuration.evmOperator = a20("01");
      f.input.expectedConfiguration.solana.configuration.settlement = a20("01");
      Object.assign(f.input.provider, { send() { assert.fail("Replaced provider method must not be read"); } });
      Object.assign(f.input, { fromBlock: 999n, toBlock: 2_999n, orderId: b32("01"), termsHash: b32("01"),
        provider: { send() { assert.fail("Replaced provider must not be used"); } } });
    }
    return response;
  });
  assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
});
test("RPC evidence is owned before subsequent provider mutations", async () => {
  const f = fixture(); const receiptSnapshot = structuredClone(f.receipt);
  f.hook((c, response) => {
    if (c.method === "eth_getTransactionReceipt" && c.occurrence === 1) {
      f.log.topics[1] = b32("01"); f.log.blockHash = b32("01"); f.log.data = "0x";
    }
    if (c.method === "eth_chainId" && c.occurrence === 2) {
      f.receipt.logs.length = 0; f.receipt.blockHash = b32("01");
    }
    if (c.method === "eth_getTransactionReceipt" && c.occurrence >= 2) return receiptSnapshot;
    return response;
  });
  assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
});
test("provider mutations of RPC parameters do not alter trusted inputs", async () => {
  const f = fixture();
  f.hook((c, response, params) => {
    if (c.method === "eth_getLogs") Object.assign(params[0] as object, { address: a20("01"), topics: [] });
    return response;
  });
  assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
});
test("results own their nested terms and remain independent across attempts", async () => {
  const f = fixture(); const before = structuredClone({ terms: f.input.terms, configuration: f.input.expectedConfiguration,
    logs: f.logs, receipt: f.receipt, transaction: f.transaction, record: f.record });
  const first = await discoverTerminalOutcome(f.input); assert.deepEqual(first, f.output);
  assert.equal(first.kind, "Observed"); if (first.kind !== "Observed" || first.observation.kind !== "Confirmed") assert.fail();
  first.observation.terms.identity.domain.sourceDomain = b32("01"); first.observation.receipt.filledQuantity = 1n;
  assert.deepEqual({ terms: f.input.terms, configuration: f.input.expectedConfiguration, logs: f.logs,
    receipt: f.receipt, transaction: f.transaction, record: f.record }, before);
  assert.deepEqual(await discoverTerminalOutcome(f.input), f.output);
});
test("ethers JsonRpcProvider satisfies the read-only discovery interface without network access", () => {
  const provider = new JsonRpcProvider("http://127.0.0.1:18545", 31337, { staticNetwork: true });
  const rpc: TerminalDiscoveryRpc = provider; assert.equal(typeof rpc.send, "function"); provider.destroy();
});
