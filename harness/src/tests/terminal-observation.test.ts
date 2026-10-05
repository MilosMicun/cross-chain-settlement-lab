import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Interface, JsonRpcProvider, toQuantity } from "ethers";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { Bytes32Hex, EvmAddressHex, EvmTerms } from "../source-order.ts";
import type { ObserveTerminalOutcomeInput, TerminalReadMethod, TerminalObservationErrorCode, TerminalObservationRpc } from "../terminal-observation.ts";
const { observeTerminalOutcome, TerminalObservationError } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const abi = new Interface(JSON.parse(readFileSync(new URL("../../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);
const b32 = (byte: string) => `0x${byte.repeat(32)}` as Bytes32Hex;
const a20 = (byte: string) => `0x${byte.repeat(20)}` as EvmAddressHex;
const U64_MAX = (1n << 64n) - 1n;
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const sha = (value: Uint8Array) => `0x${createHash("sha256").update(value).digest("hex")}` as Bytes32Hex;
const uint = (value: bigint, width: number) => Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
type Call = { method: TerminalReadMethod; params: unknown[]; occurrence: number };

function fixture(options: { terminal?: 1 | 2; method?: "execute" | "cancel"; nonce?: bigint; user?: Bytes32Hex; cash?: bigint;
  minimum?: bigint; inclusion?: bigint; additional?: bigint } = {}) {
  const terminal = options.terminal ?? 1;
  const method = options.method ?? (terminal === 1 ? "execute" : "cancel");
  const terms: EvmTerms = { identity: { domain: { sourceDomain: b32("11"), destinationDomain: b32("22"),
    solanaProgram: b32("33"), chainId: 31337n, settlement: a20("44") }, user: options.user ?? b32("55"), nonce: options.nonce ?? 7n },
  market: b32("66"), outcome: 0, cashAmount: options.cash ?? 10_000_000n, minimumShares: options.minimum ?? 20_000_000n };
  const d = terms.identity.domain;
  // Independent SPEC fixed-width SHA-256 preimages; no observer/encoder calls.
  const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
  const id = sha(Buffer.concat([Buffer.from("CCSLID01"), domain, raw(terms.identity.user), uint(terms.identity.nonce, 8)]));
  const hash = sha(Buffer.concat([Buffer.from("CCSLTR01"), domain, raw(id), raw(terms.identity.user), uint(terms.identity.nonce, 8),
    raw(terms.market), Buffer.from([0]), uint(terms.cashAmount, 8), uint(terms.minimumShares, 8)]));
  const content = { termsHash: hash, terminal, filledQuantity: terminal === 1 ? 2n * terms.cashAmount : 0n };
  const receiptHash = sha(Buffer.concat([Buffer.from("CCSLRC01"), raw(hash), Buffer.from([terminal]), uint(content.filledQuantity, 8)]));
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
  const transactionHash = b32("ee");
  const receipt = { transactionHash, status: "0x1", from: shared.evmOperator, to: shared.settlement,
    blockNumber: toQuantity(inclusion.number), blockHash: inclusion.hash, transactionIndex: "0x0", logs: [] };
  const transaction = { hash: transactionHash, from: shared.evmOperator, to: shared.settlement, chainId: "0x7a69", value: "0x0",
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionIndex: "0x0", input: abi.encodeFunctionData(method, [id, terms]) };
  const record = { terms: structuredClone(terms), termsHash: hash, status: BigInt(terminal), filledQuantity: content.filledQuantity, receiptHash };
  const records = { [inclusion.hash]: structuredClone(record), [head.hash]: structuredClone(record) };
  const calls: Call[] = [];
  let hook: ((call: Call, response: unknown) => unknown | Promise<unknown>) | undefined;
  const provider: TerminalObservationRpc = new Proxy({
    async send(method: TerminalReadMethod, params: unknown[]): Promise<unknown> {
      const call: Call = { method, params: structuredClone(params), occurrence: calls.filter((c) => c.method === method).length + 1 };
      calls.push(call);
      let response: unknown;
      switch (method) {
        case "eth_chainId": assert.deepEqual(params, []); response = "0x7a69"; break;
        case "eth_getTransactionReceipt": assert.deepEqual(params, [transactionHash]); response = receipt; break;
        case "eth_getTransactionByHash": assert.deepEqual(params, [transactionHash]); response = transaction; break;
        case "eth_getBlockByNumber": {
          assert.equal(params[1], false);
          const selected = params[0] === "latest" || params[0] === toQuantity(head.number) ? head : inclusion;
          assert.ok(["latest", toQuantity(head.number), toQuantity(inclusion.number)].includes(params[0] as string));
          response = { number: toQuantity(selected.number), hash: selected.hash }; break;
        }
        case "eth_call": {
          const request = params[0] as { to: string; data: string };
          const tag = params[1] as { blockHash: string; requireCanonical: boolean };
          assert.equal(request.to, shared.settlement);
          assert.deepEqual(Object.keys(tag).sort(), ["blockHash", "requireCanonical"]);
          assert.equal(tag.requireCanonical, true);
          assert.ok([inclusion.hash, head.hash].includes(tag.blockHash as Bytes32Hex), "Explicit identified block hash; no latest storage reads");
          const parsed = abi.parseTransaction({ data: request.data }); assert.ok(parsed);
          assert.ok(["domain", "operator", "orderRecord"].includes(parsed.name));
          if (parsed.name === "orderRecord") assert.equal(parsed.args[0], id);
          response = abi.encodeFunctionResult(parsed.name, [parsed.name === "domain" ? d : parsed.name === "operator" ? shared.evmOperator : records[tag.blockHash]]);
          break;
        }
        default: assert.fail(`Forbidden RPC, submission, mining or persistence: ${String(method)}`);
      }
      const detached = structuredClone(response);
      return hook ? hook(call, detached) : detached;
    },
  }, { get(target, property, receiver) {
    assert.equal(property, "send", `Unexpected provider capability: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  const input: ObserveTerminalOutcomeInput = { provider, expectedConfiguration, orderId: id, termsHash: hash, terms: structuredClone(terms), transactionHash };
  const output = { kind: "Confirmed", orderId: id, termsHash: hash, terms: structuredClone(terms), receipt: content, receiptHash,
    transactionHash, inclusion, observationHead: head, additionalBlocks: head.number - inclusion.number };
  return { input, output, receipt, transaction, records, inclusion, head, calls,
    hook: (value: typeof hook) => { hook = value; } };
}
type Fixture = ReturnType<typeof fixture>;
async function rejects(f: Fixture, code: TerminalObservationErrorCode) {
  await assert.rejects(observeTerminalOutcome(f.input), (error: unknown) => {
    assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, code, error.message); return true;
  });
}
async function notConfirmed(f: Fixture, reason: string) {
  const result = await observeTerminalOutcome(f.input);
  assert.deepEqual(result, { kind: "NotConfirmed", reason });
  assert.equal("receipt" in result, false); assert.equal("receiptHash" in result, false);
}
const getter = (call: Call) => call.method === "eth_call" ? abi.parseTransaction({ data: (call.params[0] as { data: string }).data })!.name : "";

for (const terminal of [1, 2] as const) {
  test(`valid ${terminal === 1 ? "Filled" : "Cancelled"} at exact N + 2 with canonical independent receipt`, async () => {
    const f = fixture({ terminal });
    assert.equal(f.input.orderId, "0xbd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7");
    assert.equal(f.input.termsHash, "0x081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8");
    assert.equal(f.output.receiptHash, terminal === 1 ? "0xbeb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888"
      : "0xacc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b");
    assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
    assert.deepEqual(f.calls.map((c) => c.method), ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber",
      "eth_getBlockByNumber", ...Array(6).fill("eth_call"), "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
    for (const at of [f.inclusion, f.head]) assert.deepEqual(f.calls.filter((c) => c.method === "eth_call"
      && (c.params[1] as { blockHash: string }).blockHash === at.hash).map(getter), ["domain", "operator", "orderRecord"]);
  });
}
test("N + 1 is insufficient even though inclusion counts as a confirmation", async () => {
  const f = fixture({ additional: 1n }); await notConfirmed(f, "InsufficientAdditionalBlocks");
  assert.equal(f.calls.some((c) => c.method === "eth_call"), false);
});
test("reports actual additional-block count beyond the fixed minimum", async () => {
  const f = fixture({ additional: 5n }); assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
});
test("maximum usable nonce, cash and fill plus full-width block numbers preserve bigint precision", async () => {
  const f = fixture({ nonce: U64_MAX - 1n, cash: U64_MAX / 2n, minimum: U64_MAX - 1n, inclusion: 9_007_199_254_740_993n });
  assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
  assert.equal(f.output.receipt.filledQuantity, U64_MAX - 1n);
});
test("successful exact execute replay requires no TerminalRecorded event", async () => {
  const f = fixture(); assert.deepEqual(f.receipt.logs, []); assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
});
test("successful cancel can observe an existing Filled terminal record without events", async () => {
  const f = fixture({ method: "cancel" }); assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
});
test("Cancelled accepts an unattainable positive uint64 minimum", async () => {
  const f = fixture({ terminal: 2, cash: 1n, minimum: U64_MAX }); assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
});
test("successful execute cannot attest Cancelled even with otherwise consistent storage", async () => {
  const f = fixture({ terminal: 2, method: "execute" }); await rejects(f, "RecordMismatch");
});
for (const [method, reason] of [["eth_getTransactionReceipt", "MissingReceipt"], ["eth_getTransactionByHash", "MissingTransaction"]] as const) {
  test(`${reason} carries no terminal attestation and does not infer Unseen`, async () => {
    const f = fixture(); f.hook((c, response) => c.method === method ? null : response); await notConfirmed(f, reason);
    assert.equal(f.calls.some((c) => c.method === "eth_call"), false);
  });
}
test("status-zero transaction is a typed failure, never an attestation", async () => {
  const f = fixture(); f.receipt.status = "0x0"; await rejects(f, "FailedTransaction"); assert.equal(f.calls.length, 2);
});
test("Unseen storage contradicts successful terminal transaction evidence", async () => {
  const f = fixture(); f.records[f.inclusion.hash].status = 0n; await rejects(f, "RecordMismatch");
});
test("wrong actual RPC chain ID rejects before reading receipts", async () => {
  const f = fixture(); f.hook((c, response) => c.method === "eth_chainId" ? "0x1" : response);
  await rejects(f, "BindingMismatch"); assert.equal(f.calls.length, 1);
});
for (const target of ["receipt", "transaction"] as const) {
  for (const [field, value] of [[target === "receipt" ? "transactionHash" : "hash", b32("01")], ["from", a20("01")],
    ["to", a20("01")], ...(target === "transaction" ? [["blockHash", b32("01")], ["blockNumber", "0xb"], ["transactionIndex", "0x1"],
      ["chainId", "0x1"], ["value", "0x1"]] : [])] as const) {
    test(`wrong ${target} ${field} rejects contradictory binding`, async () => {
      const f = fixture(); Object.assign(f[target], { [field]: value }); await rejects(f, "BindingMismatch");
    });
  }
}
for (const [label, change] of [
  ["order ID", (f: Fixture) => abi.encodeFunctionData("execute", [b32("01"), f.input.terms])],
  ["nested nonce", (f: Fixture) => abi.encodeFunctionData("execute", [f.input.orderId, { ...f.input.terms,
    identity: { ...f.input.terms.identity, nonce: 8n } }])],
  ["nested domain", (f: Fixture) => abi.encodeFunctionData("cancel", [f.input.orderId, { ...f.input.terms,
    identity: { ...f.input.terms.identity, domain: { ...f.input.terms.identity.domain, destinationDomain: b32("01") } } }])],
  ["cash amount", (f: Fixture) => abi.encodeFunctionData("execute", [f.input.orderId, { ...f.input.terms, cashAmount: 9n }])],
  ["unrelated method", () => abi.encodeFunctionData("operator")],
  ["trailing bytes", (f: Fixture) => f.transaction.input + "00"],
] as const) {
  test(`wrong calldata ${label} cannot attest expected terms`, async () => {
    const f = fixture(); f.transaction.input = change(f); await rejects(f, "BindingMismatch");
  });
}
for (const value of ["0x1234", "0xdeadbeef", "0xzz"] as const) {
  test(`malformed/unknown calldata ${value} has a typed error`, async () => {
    const f = fixture(); f.transaction.input = value; await rejects(f, "MalformedEvidence");
  });
}
for (const name of ["domain", "operator"] as const) {
  for (const at of ["inclusion", "head"] as const) {
    test(`wrong actual ${name} at ${at} rejects deployment binding`, async () => {
      const f = fixture(); f.hook((c, response) => getter(c) === name && (c.params[1] as { blockHash: string }).blockHash === f[at].hash
        ? abi.encodeFunctionResult(name, [name === "operator" ? a20("01") : { ...f.input.terms.identity.domain, sourceDomain: b32("01") }]) : response);
      await rejects(f, "BindingMismatch");
    });
  }
}
const storedMutations: [string, (r: Fixture["records"][string]) => void][] = [
  ["source domain", (r) => { r.terms.identity.domain.sourceDomain = b32("01"); }],
  ["destination domain", (r) => { r.terms.identity.domain.destinationDomain = b32("01"); }],
  ["Solana program", (r) => { r.terms.identity.domain.solanaProgram = b32("01"); }],
  ["chain ID", (r) => { r.terms.identity.domain.chainId = 1n; }],
  ["settlement", (r) => { r.terms.identity.domain.settlement = a20("01"); }],
  ["user", (r) => { r.terms.identity.user = b32("01"); }],
  ["nonce", (r) => { r.terms.identity.nonce = 8n; }],
  ["market", (r) => { r.terms.market = b32("01"); }],
  ["outcome", (r) => { Object.assign(r.terms, { outcome: 1 }); }],
  ["cash", (r) => { r.terms.cashAmount -= 1n; }],
  ["minimum", (r) => { r.terms.minimumShares -= 1n; }],
  ["terms hash", (r) => { r.termsHash = b32("01"); }],
  ["quantity", (r) => { r.filledQuantity -= 1n; }],
  ["receipt hash", (r) => { r.receiptHash = b32("01"); }],
  ["unknown status", (r) => { r.status = 3n; }],
];
for (const [label, mutate] of storedMutations) {
  test(`altered stored ${label} rejects record evidence`, async () => {
    const f = fixture(); mutate(f.records[f.inclusion.hash]); await rejects(f, "RecordMismatch");
  });
}
test("Cancelled nonzero stored quantity rejects even if receipt hash matches it", async () => {
  const f = fixture({ terminal: 2 }); const r = f.records[f.inclusion.hash]; r.filledQuantity = 1n;
  r.receiptHash = sha(Buffer.concat([Buffer.from("CCSLRC01"), raw(r.termsHash), Buffer.from([2]), uint(1n, 8)]));
  await rejects(f, "RecordMismatch");
});
test("Filled below minimum rejects even if full quantity and receipt hash match", async () => {
  const f = fixture({ minimum: 20_000_001n }); await rejects(f, "RecordMismatch");
});
test("individually valid Filled inclusion and Cancelled head contradict permanence", async () => {
  const f = fixture({ method: "cancel" }); const r = f.records[f.head.hash]; r.status = 2n; r.filledQuantity = 0n;
  r.receiptHash = sha(Buffer.concat([Buffer.from("CCSLRC01"), raw(r.termsHash), Buffer.from([2]), uint(0n, 8)]));
  await rejects(f, "RecordMismatch");
});
for (const stage of ["initial inclusion", "recheck inclusion", "recheck head"] as const) {
  for (const change of ["missing", "hash", "number"] as const) {
    test(`${stage} canonical block ${change} prevents confirmation`, async () => {
      const f = fixture(); const occurrence = stage === "initial inclusion" ? 2 : stage === "recheck inclusion" ? 3 : 4;
      f.hook((c, response) => c.method === "eth_getBlockByNumber" && c.occurrence === occurrence
        ? change === "missing" ? null : { ...(response as object), [change]: change === "hash" ? b32("01") : "0x99" } : response);
      await notConfirmed(f, change === "missing" ? "CanonicalEvidenceUnavailable" : "CanonicalEvidenceChanged");
    });
  }
}
test("unavailable identified head prevents confirmation", async () => {
  const f = fixture(); f.hook((c, response) => c.method === "eth_getBlockByNumber" && c.occurrence === 1 ? null : response);
  await notConfirmed(f, "CanonicalEvidenceUnavailable");
});
for (const change of ["missing", "blockHash", "blockNumber", "logs"] as const) {
  test(`receipt ${change} during final recheck prevents confirmation`, async () => {
    const f = fixture(); f.hook((c, response) => c.method === "eth_getTransactionReceipt" && c.occurrence === 2
      ? change === "missing" ? null : { ...(response as object), [change]: change === "blockHash" ? b32("01") : change === "blockNumber" ? "0xb" : [{ data: "0x" }] } : response);
    await notConfirmed(f, change === "missing" ? "CanonicalEvidenceUnavailable" : "CanonicalEvidenceChanged");
  });
}
test("failed receipt on recheck propagates failure", async () => {
  const f = fixture(); f.hook((c, response) => c.method === "eth_getTransactionReceipt" && c.occurrence === 2 ? { ...(response as object), status: "0x0" } : response);
  await rejects(f, "FailedTransaction");
});

const inputMutations: [string, (f: Fixture) => void, TerminalObservationErrorCode][] = [
  ["missing RPC capability", (f) => { Object.assign(f.input, { provider: {} }); }, "InvalidInput"],
  ["order width", (f) => { Object.assign(f.input, { orderId: "0x01" }); }, "InvalidInput"],
  ["terms hash width", (f) => { Object.assign(f.input, { termsHash: "0x01" }); }, "InvalidInput"],
  ["transaction hash width", (f) => { Object.assign(f.input, { transactionHash: "0x01" }); }, "InvalidInput"],
  ["noncanonical order hash", (f) => { Object.assign(f.input, { orderId: b32("01") }); }, "InvalidInput"],
  ["noncanonical terms hash", (f) => { Object.assign(f.input, { termsHash: b32("01") }); }, "InvalidInput"],
  ["user byte width", (f) => { Object.assign(f.input.terms.identity, { user: "0x01" }); }, "InvalidInput"],
  ["negative nonce", (f) => { f.input.terms.identity.nonce = -1n; }, "InvalidInput"],
  ["nonce above uint64", (f) => { f.input.terms.identity.nonce = U64_MAX + 1n; }, "InvalidInput"],
  ["cash as Number", (f) => { Object.assign(f.input.terms, { cashAmount: 10_000_000 }); }, "InvalidInput"],
  ["minimum above uint64", (f) => { f.input.terms.minimumShares = U64_MAX + 1n; }, "InvalidInput"],
  ["chain above uint256", (f) => { f.input.terms.identity.domain.chainId = 1n << 256n; }, "InvalidInput"],
  ["missing nested terms", (f) => { Object.assign(f.input, { terms: {} }); }, "InvalidInput"],
  ["shared operator disagreement", (f) => { f.input.expectedConfiguration.solana.configuration.evmOperator = a20("01"); }, "BindingMismatch"],
  ["trusted chain", (f) => { f.input.expectedConfiguration.evm.configuration.chainId = "1"; }, "BindingMismatch"],
  ["trusted RPC chain", (f) => { f.input.expectedConfiguration.evm.rpcChainId = "1"; }, "BindingMismatch"],
  ["trusted market disagreement", (f) => { f.input.expectedConfiguration.solana.configuration.market = b32("01"); }, "BindingMismatch"],
  ["trusted invalid byte width", (f) => { f.input.expectedConfiguration.evm.configuration.sourceDomain = "0x01"; }, "InvalidInput"],
  ["trusted zero binding", (f) => { f.input.expectedConfiguration.evm.configuration.evmOperator = a20("00"); }, "InvalidInput"],
];
test("null top-level input returns a stable typed input error", async () => {
  await assert.rejects(observeTerminalOutcome(null as unknown as ObserveTerminalOutcomeInput), (error: unknown) => {
    assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, "InvalidInput"); return true;
  });
});
for (const [label, mutate, code] of inputMutations) {
  test(`invalid input ${label} rejects before RPC`, async () => {
    const f = fixture(); mutate(f); await rejects(f, code); assert.equal(f.calls.length, 0);
  });
}
for (const [label, options] of [["reserved maximum nonce", { nonce: U64_MAX }], ["zero user", { user: b32("00") }], ["zero cash", { cash: 0n }],
  ["cash above full-fill bound", { cash: U64_MAX / 2n + 1n }], ["zero minimum", { minimum: 0n }]] as const) {
  test(`canonical hashes do not bypass ${label} policy`, async () => {
    const f = fixture(options); await rejects(f, "InvalidInput"); assert.equal(f.calls.length, 0);
  });
}
for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "settlement", "market"] as const) {
  test(`canonical expected terms must bind trusted deployment ${field}`, async () => {
    const f = fixture();
    for (const config of [f.input.expectedConfiguration.evm.configuration, f.input.expectedConfiguration.solana.configuration]) {
      config[field] = field === "settlement" ? a20("01") : b32("01");
    }
    await rejects(f, "BindingMismatch"); assert.equal(f.calls.length, 0);
  });
}
for (const [label, method, patch] of [
  ["unsafe Number block", "eth_getTransactionReceipt", { blockNumber: Number.MAX_SAFE_INTEGER + 1 }],
  ["noncanonical padded quantity", "eth_getTransactionReceipt", { blockNumber: "0x00a" }],
  ["negative block", "eth_getTransactionReceipt", { blockNumber: "-0x1" }],
  ["over-width block", "eth_getTransactionReceipt", { blockNumber: toQuantity(1n << 256n) }],
  ["invalid status", "eth_getTransactionReceipt", { status: "0x2" }],
  ["receipt block hash width", "eth_getTransactionReceipt", { blockHash: "0x01" }],
  ["null recipient", "eth_getTransactionReceipt", { to: null }],
  ["transaction missing chain ID", "eth_getTransactionByHash", { chainId: undefined }],
  ["unsafe Number value", "eth_getTransactionByHash", { value: Number.MAX_SAFE_INTEGER + 1 }],
  ["head number type", "eth_getBlockByNumber", { number: 12 }],
  ["head hash width", "eth_getBlockByNumber", { hash: "0x01" }],
] as const) {
  test(`malformed evidence ${label} rejects without unsafe conversion`, async () => {
    const f = fixture(); f.hook((c, response) => c.method === method ? { ...(response as object), ...patch } : response);
    await rejects(f, "MalformedEvidence");
  });
}
for (const response of [undefined, [], "not an object"] as const) {
  test(`malformed receipt shape ${String(response)} has typed error`, async () => {
    const f = fixture(); f.hook((c, value) => c.method === "eth_getTransactionReceipt" ? response : value);
    await rejects(f, "MalformedEvidence");
  });
}
for (const name of ["domain", "operator", "orderRecord"] as const) {
  test(`malformed ABI response for ${name} has typed error`, async () => {
    const f = fixture(); f.hook((c, response) => getter(c) === name ? "0x01" : response); await rejects(f, "MalformedEvidence");
  });
}
for (const method of ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"] as const) {
  test(`RPC failure during ${method} propagates typed error with original cause`, async () => {
    const f = fixture(); const cause = new Error("Controlled read failure");
    f.hook((c, response) => { if (c.method === method) throw cause; return response; });
    await assert.rejects(observeTerminalOutcome(f.input), (error: unknown) => {
      assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, "RpcFailure"); assert.equal(error.cause, cause); return true;
    });
    assert.equal(f.calls.at(-1)!.method, method, "No retries or fallback to latest after an RPC failure");
  });
}
test("canonical-history eth_call failure cannot trigger an unpinned fallback", async () => {
  const f = fixture(); f.hook((c, response) => {
    if (getter(c) === "orderRecord" && (c.params[1] as { blockHash: string }).blockHash === f.head.hash) {
      throw new Error("Header no longer canonical");
    }
    return response;
  });
  await rejects(f, "RpcFailure"); assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 6);
});
test("per-request deadline bounds a hung read and clears its timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture(); f.hook(() => new Promise(() => {}));
  const observed = observeTerminalOutcome(f.input);
  const assertion = assert.rejects(observed, (error: unknown) => {
    assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, "RequestDeadline"); return true;
  });
  context.mock.timers.tick(9_999); let settled = false; void observed.catch(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  context.mock.timers.tick(1); await assertion;
  assert.equal(f.calls.length, 1); assert.equal(clear.mock.callCount(), 1);
});
test("overall deadline caps a late hung request at remaining six seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0; context.mock.method(Date, "now", () => now);
  const f = fixture(); let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  f.hook((_c, response) => {
    if (f.calls.length === 7) { signal(); return new Promise(() => {}); }
    now += 9_000; return response;
  });
  const observed = observeTerminalOutcome(f.input);
  const assertion = assert.rejects(observed, (error: unknown) => {
    assert.ok(error instanceof TerminalObservationError); assert.equal(error.code, "OverallDeadline"); return true;
  });
  await reached; context.mock.timers.tick(6_000); await assertion; assert.equal(f.calls.length, 7);
});
test("overall deadline also rejects delayed successful RPC resolution", async (context) => {
  let now = 0; context.mock.method(Date, "now", () => now);
  const f = fixture(); f.hook((_c, response) => { now += 9_000; return response; });
  await rejects(f, "OverallDeadline"); assert.equal(f.calls.length, 7);
});
test("per-request deadline rejects late successful resolution when the timer cannot run first", async (context) => {
  let now = 0; context.mock.method(Date, "now", () => now);
  const f = fixture(); f.hook((_c, response) => { now += 10_000; return response; });
  await rejects(f, "RequestDeadline"); assert.equal(f.calls.length, 1);
});
test("successful and failed observations clear every request timer", async (context) => {
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture(); assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
  assert.equal(clear.mock.callCount(), f.calls.length);
  const failure = fixture(); failure.hook(() => { throw new Error("Read failure"); }); await rejects(failure, "RpcFailure");
  assert.equal(clear.mock.callCount(), f.calls.length + 1);
});
test("caller mutation during asynchronous observation cannot change expected identity or configuration", async () => {
  const f = fixture();
  f.hook((c, response) => {
    if (c.method === "eth_chainId") {
      f.input.terms.identity.domain.sourceDomain = b32("01"); f.input.terms.cashAmount = 1n; f.input.terms.identity.nonce = 9n;
      f.input.expectedConfiguration.evm.configuration.evmOperator = a20("01");
      f.input.expectedConfiguration.solana.configuration.settlement = a20("01");
      Object.assign(f.input, { orderId: b32("01"), termsHash: b32("01"), transactionHash: b32("01"),
        provider: { send() { assert.fail("Caller replacement of provider must not be used"); } } });
    }
    return response;
  });
  assert.deepEqual(await observeTerminalOutcome(f.input), f.output);
});
test("ethers JsonRpcProvider satisfies narrow read interface without making a network request", () => {
  const provider = new JsonRpcProvider("http://127.0.0.1:18545", 31337, { staticNetwork: true });
  const rpc: TerminalObservationRpc = provider; assert.equal(typeof rpc.send, "function"); provider.destroy();
});
