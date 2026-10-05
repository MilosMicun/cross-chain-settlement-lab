import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Bytes32Hex, EvmAddressHex, EvmTerms, FinalizedRecoveryOrder } from "../source-order.ts";
import type { TerminalObservationResult } from "../terminal-observation.ts";
import type { PlanRecoveryInput, RecoveryPlan, RecoveryPlanError as PlannerError } from "../recovery-plan.ts";
const { planRecovery, RecoveryPlanError } = await import(new URL("../recovery-plan.ts", import.meta.url).href) as typeof import("../recovery-plan.ts");

// Public synthetic terms and independent manual preimages only. No adapter,
// encoder under test, filesystem, process, provider or transaction operation.
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const b32 = (byte: string) => `0x${byte.repeat(32)}` as Bytes32Hex;
const a20 = (byte: string) => `0x${byte.repeat(20)}` as EvmAddressHex;
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const sha = (bytes: Buffer) => `0x${createHash("sha256").update(bytes).digest("hex")}` as Bytes32Hex;
function uint(value: bigint, width: number): Buffer {
  const encoded = value.toString(16).padStart(width * 2, "0");
  assert.equal(encoded.length, width * 2);
  return Buffer.from(encoded, "hex");
}
function terms(): EvmTerms {
  return { identity: { domain: { sourceDomain: b32("11"), destinationDomain: b32("22"), solanaProgram: b32("33"),
    chainId: 31337n, settlement: a20("44") }, user: b32("55"), nonce: 7n },
  market: b32("66"), outcome: 0, cashAmount: 10_000_000n, minimumShares: 20_000_000n };
}
function hashes(t: EvmTerms) {
  const d = t.identity.domain;
  const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
  const identity = Buffer.concat([Buffer.from("CCSLID01"), domain, raw(t.identity.user), uint(t.identity.nonce, 8)]);
  assert.equal(identity.length, 196);
  const orderId = sha(identity);
  const preimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, raw(orderId), raw(t.identity.user), uint(t.identity.nonce, 8),
    raw(t.market), Buffer.from([t.outcome]), uint(t.cashAmount, 8), uint(t.minimumShares, 8)]);
  assert.equal(preimage.length, 277);
  return { orderId, termsHash: sha(preimage) };
}
function receiptHash(termsHash: string, terminal: number, quantity: bigint) {
  const preimage = Buffer.concat([Buffer.from("CCSLRC01"), raw(termsHash), Buffer.from([terminal]), uint(quantity, 8)]);
  assert.equal(preimage.length, 49);
  return sha(preimage);
}
type SourceState = FinalizedRecoveryOrder["state"];
type Confirmed = Extract<TerminalObservationResult, { kind: "Confirmed" }>;
function confirmed(t: EvmTerms = terms(), terminal: 1 | 2 = 1): Confirmed {
  const binding = hashes(t);
  const filledQuantity = terminal === 1 ? 2n * t.cashAmount : 0n;
  return { kind: "Confirmed", ...binding, terms: structuredClone(t),
    receipt: { termsHash: binding.termsHash, terminal, filledQuantity },
    receiptHash: receiptHash(binding.termsHash, terminal, filledQuantity), transactionHash: b32("ab"),
    inclusion: { number: 10n, hash: b32("cd") }, observationHead: { number: 12n, hash: b32("ef") }, additionalBlocks: 2n };
}
function source(state: SourceState = "Pending", t: EvmTerms = terms(), cancellation = state === "CancelRequested" || state === "Refunded"): FinalizedRecoveryOrder {
  const binding = hashes(t);
  const base = { accounts: { config: "synthetic-config", userNonce: "synthetic-nonce", order: "synthetic-order",
    escrow: "synthetic-escrow", userCashAta: "synthetic-cash", userYesAta: "synthetic-yes" },
  contextSlot: 123, ...binding, terms: structuredClone(t), escrowBalance: state === "Pending" || state === "CancelRequested" ? t.cashAmount : 0n };
  if (state === "Pending") return { ...base, state, cancellationRequested: false, acceptedReceipt: null };
  if (state === "CancelRequested") return { ...base, state, cancellationRequested: true, acceptedReceipt: null };
  if (state === "Settled") return { ...base, state, cancellationRequested: cancellation,
    acceptedReceipt: { terminal: 1, filledQuantity: 2n * t.cashAmount, receiptHash: receiptHash(binding.termsHash, 1, 2n * t.cashAmount) } };
  return { ...base, state, cancellationRequested: true,
    acceptedReceipt: { terminal: 2, filledQuantity: 0n, receiptHash: receiptHash(binding.termsHash, 2, 0n) } };
}
function rejects(input: unknown, code: PlannerError["code"]) {
  assert.throws(() => planRecovery(input as PlanRecoveryInput), (error: unknown) => {
    assert.ok(error instanceof RecoveryPlanError);
    assert.equal(error.name, "RecoveryPlanError");
    assert.equal(error.code, code);
    return true;
  });
}
const states = ["Pending", "CancelRequested", "Settled", "Refunded"] as const;
const reasons = ["MissingReceipt", "MissingTransaction", "InsufficientAdditionalBlocks", "CanonicalEvidenceUnavailable", "CanonicalEvidenceChanged"] as const;

test("independent preimages preserve the canonical specification vector", () => {
  const d = confirmed();
  assert.equal(d.orderId, "0xbd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7");
  assert.equal(d.termsHash, "0x081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8");
  assert.equal(d.receiptHash, "0xbeb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888");
  assert.equal(confirmed(terms(), 2).receiptHash, "0xacc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b");
});
for (const state of states) {
  for (const reason of [null, ...reasons]) {
    test(`${state} with ${reason ?? "null"} only waits for destination confirmation`, () => {
      const s = source(state);
      assert.deepEqual(planRecovery({ source: s, destination: reason === null ? null : { kind: "NotConfirmed", reason } }),
        { kind: "Wait", orderId: s.orderId, termsHash: s.termsHash,
          reason: reason === null ? "DestinationNotObserved" : "DestinationNotConfirmed" });
    });
  }
  for (const terminal of [1, 2] as const) {
    test(`${state} reconciles Confirmed/${terminal === 1 ? "Filled" : "Cancelled"}`, () => {
      const s = source(state), d = confirmed(terms(), terminal);
      const input = { source: s, destination: d };
      if ((state === "Settled" && terminal === 2) || (state === "Refunded" && terminal === 1)) {
        rejects(input, "TerminalConflict"); return;
      }
      const expected: RecoveryPlan = state === "Settled" || state === "Refunded"
        ? { kind: "Complete", sourceState: state, orderId: s.orderId, termsHash: s.termsHash, receiptHash: d.receiptHash }
        : state === "Pending" && terminal === 2
          ? { kind: "Wait", reason: "SourceCancellationRequired", orderId: s.orderId, termsHash: s.termsHash }
          : { kind: terminal === 1 ? "DeliverFilled" : "DeliverCancelled", orderId: s.orderId, termsHash: s.termsHash, receiptHash: d.receiptHash };
      assert.deepEqual(planRecovery(input), expected);
    });
  }
}
test("Settled after cancellation accepts only its exact Filled receipt", () => {
  const s = source("Settled", terms(), true), d = confirmed();
  assert.deepEqual(planRecovery({ source: s, destination: d }),
    { kind: "Complete", sourceState: "Settled", orderId: s.orderId, termsHash: s.termsHash, receiptHash: d.receiptHash });
  rejects({ source: s, destination: confirmed(terms(), 2) }, "TerminalConflict");
  for (const reason of [null, ...reasons]) {
    assert.deepEqual(planRecovery({ source: s, destination: reason === null ? null : { kind: "NotConfirmed", reason } }),
      { kind: "Wait", orderId: s.orderId, termsHash: s.termsHash,
        reason: reason === null ? "DestinationNotObserved" : "DestinationNotConfirmed" });
  }
});

for (const state of states) {
  for (const cancellation of [false, true]) {
    for (const accepted of [null, 1, 2] as const) {
      const valid = (state === "Pending" && !cancellation && accepted === null)
        || (state === "CancelRequested" && cancellation && accepted === null)
        || (state === "Settled" && accepted === 1)
        || (state === "Refunded" && cancellation && accepted === 2);
      if (valid) continue;
      test(`rejects lifecycle ${state}, cancellation=${cancellation}, receipt=${accepted}`, () => {
        const s = source(state), d = confirmed(terms(), accepted ?? 1);
        Object.assign(s, { cancellationRequested: cancellation, acceptedReceipt: accepted === null ? null
          : { terminal: accepted, filledQuantity: d.receipt.filledQuantity, receiptHash: d.receiptHash } });
        rejects({ source: s, destination: null }, "InvalidSource");
      });
    }
  }
}
const sourceMutations: [string, (s: FinalizedRecoveryOrder) => void][] = [
  ["unknown state", (s) => Object.assign(s, { state: "Unseen" })],
  ["nonboolean cancellation", (s) => Object.assign(s, { cancellationRequested: 1 })],
  ["missing receipt field", (s) => Object.assign(s, { acceptedReceipt: undefined })],
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "123", 123n].map((contextSlot): [string, (s: FinalizedRecoveryOrder) => void] =>
    [`invalid slot ${String(contextSlot)}`, (s) => Object.assign(s, { contextSlot })]),
  ...[-1n, U64_MAX + 1n, 10_000_000, "10000000"].map((escrowBalance): [string, (s: FinalizedRecoveryOrder) => void] =>
    [`invalid escrow ${String(escrowBalance)}`, (s) => Object.assign(s, { escrowBalance })]),
];
for (const [label, mutate] of sourceMutations) {
  test(`source ${label} rejects even without destination confirmation`, () => {
    for (const destination of [null, { kind: "NotConfirmed", reason: "MissingReceipt" }] as const) {
      const s = source(); mutate(s); rejects({ source: s, destination }, "InvalidSource");
    }
  });
}
for (const state of ["Pending", "CancelRequested"] as const) {
  test(`${state} rejects active escrow shortage`, () => {
    const s = source(state); s.escrowBalance -= 1n;
    rejects({ source: s, destination: confirmed() }, "InvalidSource");
  });
}
for (const state of states) {
  test(`${state} accepts valid uint64 donations${state === "Settled" || state === "Refunded" ? " and empty terminal escrow" : ""}`, () => {
    const s = source(state), d = confirmed(terms(), state === "Refunded" ? 2 : 1);
    const before = planRecovery({ source: s, destination: d });
    s.escrowBalance = U64_MAX;
    assert.deepEqual(planRecovery({ source: s, destination: d }), before);
  });
}

const termMutations: [string, (t: EvmTerms) => void][] = [
  ["missing identity", (t) => Object.assign(t, { identity: null })],
  ["missing domain", (t) => Object.assign(t.identity, { domain: [] })],
  ...["sourceDomain", "destinationDomain", "solanaProgram", "settlement"].flatMap((key) =>
    ["0x01", "0x" + "zz".repeat(key === "settlement" ? 20 : 32), "0x" + "11".repeat(key === "settlement" ? 21 : 33)].map((value): [string, (t: EvmTerms) => void] =>
      [`malformed ${key} ${value.slice(0, 8)}`, (t) => Object.assign(t.identity.domain, { [key]: value })])),
  ["short user", (t) => { t.identity.user = "0x01" as Bytes32Hex; }],
  ["zero user", (t) => { t.identity.user = b32("00"); }],
  ["short market", (t) => { t.market = "0x01" as Bytes32Hex; }],
  ...[-1n, U64_MAX, U64_MAX + 1n, 7, "7"].map((nonce): [string, (t: EvmTerms) => void] =>
    [`invalid nonce ${String(nonce)}`, (t) => Object.assign(t.identity, { nonce })]),
  ...[-1n, U256_MAX + 1n, 31337, "31337"].map((chainId): [string, (t: EvmTerms) => void] =>
    [`invalid chain ${String(chainId)}`, (t) => Object.assign(t.identity.domain, { chainId })]),
  ...[1, "0", 0n, undefined].map((outcome): [string, (t: EvmTerms) => void] =>
    [`invalid outcome ${String(outcome)}`, (t) => Object.assign(t, { outcome })]),
  ...[0n, -1n, U64_MAX / 2n + 1n, U64_MAX + 1n, 10_000_000, "10000000"].map((cashAmount): [string, (t: EvmTerms) => void] =>
    [`invalid cash ${String(cashAmount)}`, (t) => Object.assign(t, { cashAmount })]),
  ...[0n, -1n, U64_MAX + 1n, 20_000_000, "20000000"].map((minimumShares): [string, (t: EvmTerms) => void] =>
    [`invalid minimum ${String(minimumShares)}`, (t) => Object.assign(t, { minimumShares })]),
];
for (const side of ["source", "destination"] as const) {
  for (const [label, mutate] of termMutations) {
    test(`${side} rejects ${label}`, () => {
      const input = { source: source(), destination: confirmed() };
      mutate(input[side].terms);
      rejects(input, side === "source" ? "InvalidSource" : "InvalidDestination");
    });
  }
}
const bindingMutations: [string, (t: EvmTerms) => void][] = [
  ...["sourceDomain", "destinationDomain", "solanaProgram"].map((key): [string, (t: EvmTerms) => void] =>
    [key, (t) => Object.assign(t.identity.domain, { [key]: b32("a1") })]),
  ["settlement", (t) => { t.identity.domain.settlement = a20("a1"); }],
  ["chain ID", (t) => { t.identity.domain.chainId = U256_MAX; }],
  ["user", (t) => { t.identity.user = b32("a1"); }],
  ["nonce", (t) => { t.identity.nonce += 1n; }],
  ["market", (t) => { t.market = b32("a1"); }],
  ["cash", (t) => { t.cashAmount += 1n; }],
  ["minimum", (t) => { t.minimumShares -= 1n; }],
];
for (const state of states) {
  for (const [label, mutate] of bindingMutations) {
    test(`${state} rejects coherently rehashed destination ${label}`, () => {
      const t = terms(); mutate(t);
      rejects({ source: source(state), destination: confirmed(t, state === "Refunded" ? 2 : 1) }, "BindingMismatch");
    });
  }
}
for (const side of ["source", "destination"] as const) {
  for (const field of ["orderId", "termsHash"] as const) {
    for (const value of [b32("a1"), "0x01", "0x" + "gg".repeat(32)]) {
      test(`${side} rejects ${field} ${value.slice(0, 8)}`, () => {
        const input = { source: source(), destination: confirmed() };
        Object.assign(input[side], { [field]: value });
        rejects(input, value === b32("a1") ? "BindingMismatch" : side === "source" ? "InvalidSource" : "InvalidDestination");
      });
    }
  }
}
test("receipt terms hash must bind the source order", () => {
  const d = confirmed(); d.receipt.termsHash = b32("a1");
  rejects({ source: source(), destination: d }, "BindingMismatch");
  d.receipt.termsHash = "0x01" as Bytes32Hex;
  rejects({ source: source(), destination: d }, "InvalidDestination");
});

for (const side of ["source", "destination"] as const) {
  for (const terminal of [1, 2] as const) {
    for (const value of [-1n, U64_MAX + 1n, 1n, terminal === 1 ? 19_999_999n : 20_000_000n, 20_000_000, "20000000"]) {
      test(`${side} rejects ${terminal} quantity ${String(value)}, even with a coherent hash when representable`, () => {
        const s = source(terminal === 1 ? "Settled" : "Refunded"), d = confirmed(terms(), terminal);
        const r = side === "source" ? s.acceptedReceipt! : d.receipt;
        Object.assign(r, { filledQuantity: value });
        if (typeof value === "bigint" && value >= 0n && value <= U64_MAX) {
          const hash = receiptHash(s.termsHash, terminal, value);
          if (side === "source") s.acceptedReceipt!.receiptHash = hash; else d.receiptHash = hash;
        }
        rejects({ source: s, destination: d }, side === "source" ? "InvalidSource" : "InvalidDestination");
      });
    }
    for (const hash of [b32("a1"), "0x01", "0x" + "zz".repeat(32)]) {
      test(`${side} rejects wrong ${terminal} receipt hash ${hash.slice(0, 8)}`, () => {
        const s = source(terminal === 1 ? "Settled" : "Refunded"), d = confirmed(terms(), terminal);
        if (side === "source") Object.assign(s.acceptedReceipt!, { receiptHash: hash }); else Object.assign(d, { receiptHash: hash });
        rejects({ source: s, destination: d }, side === "source" ? "InvalidSource" : "InvalidDestination");
      });
    }
  }
  for (const terminal of [0, 3, "1", 1n, undefined]) {
    test(`${side} rejects receipt terminal ${String(terminal)}`, () => {
      const s = source("Settled"), d = confirmed();
      Object.assign(side === "source" ? s.acceptedReceipt! : d.receipt, { terminal });
      rejects({ source: s, destination: d }, side === "source" ? "InvalidSource" : "InvalidDestination");
    });
  }
  for (const receipt of [null, undefined, [], "Filled"]) {
    test(`${side} rejects malformed receipt ${String(receipt)}`, () => {
      const s = source("Settled"), d = confirmed();
      Object.assign(side === "source" ? s : d, { [side === "source" ? "acceptedReceipt" : "receipt"]: receipt });
      rejects({ source: s, destination: d }, side === "source" ? "InvalidSource" : "InvalidDestination");
    });
  }
}

for (const state of ["Pending", "CancelRequested", "Refunded"] as const) {
  test(`${state} allows unattainable positive minimum and a Cancelled outcome`, () => {
    const t = terms(); t.cashAmount = 1n; t.minimumShares = U64_MAX;
    const s = source(state, t), d = confirmed(t, 2);
    assert.equal(planRecovery({ source: s, destination: null }).kind, "Wait");
    assert.equal(planRecovery({ source: s, destination: d }).kind,
      state === "Pending" ? "Wait" : state === "Refunded" ? "Complete" : "DeliverCancelled");
    rejects({ source: s, destination: confirmed(t) }, "InvalidDestination");
  });
}
test("Settled cannot accept a full fill below its minimum, even with a canonical receipt", () => {
  const t = terms(); t.minimumShares += 1n;
  rejects({ source: source("Settled", t), destination: null }, "InvalidSource");
});

const metadataMutations: [string, (d: Confirmed) => void][] = [
  ...["inclusion", "observationHead"].flatMap((field) => [null, [], undefined].map((value): [string, (d: Confirmed) => void] =>
    [`malformed ${field} ${String(value)}`, (d) => Object.assign(d, { [field]: value })])),
  ...["transaction", "inclusion", "head"].flatMap((field) => [b32("00"), "0x01", "0x" + "gg".repeat(32)].map((value): [string, (d: Confirmed) => void] =>
    [`invalid ${field} hash ${value.slice(0, 8)}`, (d) => {
      if (field === "transaction") Object.assign(d, { transactionHash: value });
      else Object.assign(field === "inclusion" ? d.inclusion : d.observationHead, { hash: value });
    }])),
  ...["inclusion", "observationHead"].flatMap((field) => [-1n, U256_MAX + 1n, 10, "10", undefined].map((value): [string, (d: Confirmed) => void] =>
    [`invalid ${field} number ${String(value)}`, (d) => Object.assign(field === "inclusion" ? d.inclusion : d.observationHead, { number: value })])),
  ...[-1n, 0n, 1n, 3n, U256_MAX + 1n, 2, "2", undefined].map((value): [string, (d: Confirmed) => void] =>
    [`invalid additionalBlocks ${String(value)}`, (d) => Object.assign(d, { additionalBlocks: value })]),
  ["identical block hashes by bytes", (d) => { d.observationHead.hash = `0x${d.inclusion.hash.slice(2).toUpperCase()}` as Bytes32Hex; }],
  ["head behind inclusion", (d) => { d.observationHead.number = 9n; }],
  ["only one additional block", (d) => { d.observationHead.number = 11n; d.additionalBlocks = 1n; }],
];
for (const [label, mutate] of metadataMutations) {
  test(`rejects confirmation metadata: ${label}`, () => {
    const d = confirmed(); mutate(d);
    rejects({ source: source(), destination: d }, "InvalidDestination");
  });
}
for (const value of [null, undefined, [], "input", 1, true]) {
  test(`malformed top-level input ${String(value)} has a typed error`, () => rejects(value, "InvalidInput"));
}
for (const value of [null, undefined, [], "source", 1]) {
  test(`malformed source ${String(value)} has a typed error`, () => rejects({ source: value, destination: null }, "InvalidSource"));
}
for (const destination of [undefined, [], "destination", 1, {}, { kind: "Unseen" }, { kind: "confirmed" },
  { kind: "Confirmed" }, { kind: "NotConfirmed" }, { kind: "NotConfirmed", reason: "Timeout" },
  { kind: "NotConfirmed", reason: null }, { kind: "NotConfirmed", reason: 1 }]) {
  test(`malformed destination ${JSON.stringify(destination)} has a typed error`, () =>
    rejects({ source: source(), destination }, "InvalidDestination"));
}
test("missing input fields never infer a successful outcome", () => {
  rejects({}, "InvalidSource");
  rejects({ source: source() }, "InvalidDestination");
});

test("full-width nonce, amounts, chain ID and block numbers retain bigint precision", () => {
  const t = terms(); t.identity.nonce = U64_MAX - 1n; t.identity.domain.chainId = U256_MAX;
  t.cashAmount = U64_MAX / 2n; t.minimumShares = U64_MAX - 1n;
  const s = source("Settled", t), d = confirmed(t);
  d.inclusion.number = U256_MAX - 2n; d.observationHead.number = U256_MAX;
  assert.equal(d.receipt.filledQuantity, U64_MAX - 1n);
  assert.deepEqual(planRecovery({ source: s, destination: d }),
    { kind: "Complete", sourceState: "Settled", orderId: s.orderId, termsHash: s.termsHash, receiptHash: d.receiptHash });
});
test("zero nonce/chain/block and positive safe slot boundaries are representable", () => {
  const t = terms(); t.identity.nonce = 0n; t.identity.domain.chainId = 0n;
  const s = source("Pending", t), d = confirmed(t);
  s.contextSlot = Number.MAX_SAFE_INTEGER; d.inclusion.number = 0n; d.observationHead.number = 2n;
  assert.equal(planRecovery({ source: s, destination: d }).kind, "DeliverFilled");
});
test("confirmation accepts the exact observed difference beyond N+2", () => {
  const d = confirmed(); d.observationHead.number = 15n; d.additionalBlocks = 5n;
  assert.equal(planRecovery({ source: source(), destination: d }).kind, "DeliverFilled");
});
function uppercaseHex(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("0x")) return `0x${value.slice(2).toUpperCase()}`;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, uppercaseHex(child)]));
  }
  return value;
}
test("all hex terms, hashes and accepted receipts compare by bytes regardless of letter case", () => {
  const t = terms(); t.identity.domain.settlement = a20("ab"); t.market = b32("cd");
  for (const state of states) {
    const input = { source: source(state, t), destination: confirmed(t, state === "Refunded" ? 2 : 1) };
    const expected = planRecovery(input);
    assert.deepEqual(planRecovery({ ...input, destination: uppercaseHex(input.destination) as Confirmed }), expected);
    assert.deepEqual(planRecovery({ ...input, source: uppercaseHex(input.source) as FinalizedRecoveryOrder }), expected);
    assert.deepEqual(planRecovery(uppercaseHex(input) as PlanRecoveryInput), expected);
  }
});
function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}
test("all decision variants preserve frozen inputs and return independent minimal objects", () => {
  const inputs: PlanRecoveryInput[] = [
    { source: source(), destination: null },
    { source: source(), destination: { kind: "NotConfirmed", reason: "MissingReceipt" } },
    { source: source(), destination: confirmed(terms(), 2) },
    { source: source(), destination: confirmed() },
    { source: source("CancelRequested"), destination: confirmed(terms(), 2) },
    { source: source("Settled"), destination: confirmed() },
    { source: source("Refunded"), destination: confirmed(terms(), 2) },
  ];
  for (const input of inputs) {
    const before = structuredClone(input); freezeDeep(input);
    const first = planRecovery(input), second = planRecovery(input);
    assert.deepEqual(input, before); assert.deepEqual(first, second); assert.notEqual(first, second);
    assert.ok(Object.values(first).every((value) => typeof value === "string"));
    Object.assign(first, { orderId: b32("a1"), kind: "tampered" });
    assert.deepEqual(planRecovery(input), second);
  }
});
test("later caller mutations do not change an already returned plan", () => {
  const input = { source: source("Settled"), destination: confirmed() };
  const plan = planRecovery(input), before = structuredClone(plan);
  input.source.terms.cashAmount = 1n;
  input.destination.receiptHash = b32("a1");
  Object.assign(input.source.acceptedReceipt!, { receiptHash: b32("a1") });
  assert.deepEqual(plan, before);
});
