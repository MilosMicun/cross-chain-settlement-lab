import assert from "node:assert/strict";
import { test } from "node:test";
import type { Domain, Identity, Terms, Receipt, EncodingError as EncodingErrorType } from "../protocol-encoding.ts";

// Node executes TypeScript directly. A URL import keeps the existing noEmit
// configuration compatible without enabling allowImportingTsExtensions.
const {
  EncodingError,
  identityBytes,
  orderId,
  termsBytes,
  termsHash,
  receiptBytes,
  receiptHash,
} = await import(new URL("../protocol-encoding.ts", import.meta.url).href) as typeof import("../protocol-encoding.ts");

// Independent literal fixtures from SPEC.md and the existing Rust vector tests.
// No function under test constructs an expected preimage or golden hash.
const GOLDEN_ORDER_ID = "bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7";
const GOLDEN_TERMS_HASH = "081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8";
const GOLDEN_FILLED_HASH = "beb427e1562987a08faf39384522c558b6eb1a1d0782603347959cd0537a7888";
const GOLDEN_CANCELLED_HASH = "acc9f7b21fa561c93a3d4b945a3fa7b8feb699bd0873664238270f835083540b";
const GOLDEN_IDENTITY_BYTES = [
  "4343534c49443031",
  "1111111111111111111111111111111111111111111111111111111111111111",
  "2222222222222222222222222222222222222222222222222222222222222222",
  "3333333333333333333333333333333333333333333333333333333333333333",
  "0000000000000000000000000000000000000000000000000000000000007a69",
  "4444444444444444444444444444444444444444",
  "5555555555555555555555555555555555555555555555555555555555555555",
  "0000000000000007",
].join("");
const GOLDEN_TERMS_BYTES = [
  "4343534c54523031",
  "1111111111111111111111111111111111111111111111111111111111111111",
  "2222222222222222222222222222222222222222222222222222222222222222",
  "3333333333333333333333333333333333333333333333333333333333333333",
  "0000000000000000000000000000000000000000000000000000000000007a69",
  "4444444444444444444444444444444444444444",
  "bd6edba38cc935f2d746fbf7a172183b50ba03332a3e92b737a3ea3d87d804b7",
  "5555555555555555555555555555555555555555555555555555555555555555",
  "0000000000000007",
  "6666666666666666666666666666666666666666666666666666666666666666",
  "00",
  "0000000000989680",
  "0000000001312d00",
].join("");
const GOLDEN_FILLED_BYTES =
  "4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8010000000001312d00";
const GOLDEN_CANCELLED_BYTES =
  "4343534c52433031081cd9748a1b535414e8d3911a561c1d231bba83f6fe7e728b429e1e10ec52a8020000000000000000";
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;

function goldenTerms(): Terms {
  return {
    identity: {
      domain: {
        sourceDomain: new Uint8Array(32).fill(0x11),
        destinationDomain: new Uint8Array(32).fill(0x22),
        solanaProgram: new Uint8Array(32).fill(0x33),
        chainId: 31337n,
        settlement: new Uint8Array(20).fill(0x44),
      },
      user: new Uint8Array(32).fill(0x55),
      nonce: 7n,
    },
    market: new Uint8Array(32).fill(0x66),
    outcome: 0,
    cashAmount: 10_000_000n,
    minimumShares: 20_000_000n,
  };
}

function goldenReceipt(terminal = 1): Receipt {
  return {
    termsHash: Buffer.from(GOLDEN_TERMS_HASH, "hex"),
    terminal,
    filledQuantity: terminal === 1 ? 20_000_000n : 0n,
  };
}

function withDomain(terms: Terms, patch: Partial<Domain>): Terms {
  return { ...terms, identity: { ...terms.identity, domain: { ...terms.identity.domain, ...patch } } };
}

function assertHex(bytes: Uint8Array, expected: string): void {
  assert.deepEqual(Buffer.from(bytes), Buffer.from(expected, "hex"));
}

function assertEncodingError(run: () => unknown, code: EncodingErrorType["code"], context: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof EncodingError, context);
    assert.equal(error.name, "EncodingError", context);
    assert.equal(error.code, code, context);
    return true;
  }, context);
}

test("golden identity preimage and order ID", () => {
  const identity = goldenTerms().identity;
  assertHex(identityBytes(identity), GOLDEN_IDENTITY_BYTES);
  assertHex(orderId(identity), GOLDEN_ORDER_ID);
  assert.equal(orderId(identity).length, 32);
});

test("golden terms preimage and hash", () => {
  const terms = goldenTerms();
  assertHex(termsBytes(terms), GOLDEN_TERMS_BYTES);
  assertHex(termsHash(terms), GOLDEN_TERMS_HASH);
  assert.equal(termsHash(terms).length, 32);
});

for (const [terminal, expectedBytes, expectedHash] of [
  [1, GOLDEN_FILLED_BYTES, GOLDEN_FILLED_HASH],
  [2, GOLDEN_CANCELLED_BYTES, GOLDEN_CANCELLED_HASH],
] as const) {
  test(`golden terminal ${terminal} receipt preimage and hash`, () => {
    const receipt = goldenReceipt(terminal);
    assertHex(receiptBytes(receipt), expectedBytes);
    assertHex(receiptHash(receipt), expectedHash);
    assert.equal(receiptHash(receipt).length, 32);
  });
}

test("exact preimage lengths, tags, and every field offset", () => {
  const terms = goldenTerms();
  const identity = identityBytes(terms.identity);
  const encoded = termsBytes(terms);
  assert.equal(identity.length, 196);
  assert.equal(encoded.length, 277);
  assert.equal(identity.subarray(0, 8).toString("ascii"), "CCSLID01");
  assert.equal(encoded.subarray(0, 8).toString("ascii"), "CCSLTR01");
  for (const bytes of [identity, encoded]) {
    assert.deepEqual(bytes.subarray(8, 40), Buffer.alloc(32, 0x11));
    assert.deepEqual(bytes.subarray(40, 72), Buffer.alloc(32, 0x22));
    assert.deepEqual(bytes.subarray(72, 104), Buffer.alloc(32, 0x33));
    assertHex(bytes.subarray(104, 136), "0000000000000000000000000000000000000000000000000000000000007a69");
    assert.deepEqual(bytes.subarray(136, 156), Buffer.alloc(20, 0x44));
    assert.equal(bytes.subarray(8, 156).length, 148);
  }
  assert.deepEqual(identity.subarray(156, 188), Buffer.alloc(32, 0x55));
  assertHex(identity.subarray(188, 196), "0000000000000007");
  assertHex(encoded.subarray(156, 188), GOLDEN_ORDER_ID);
  assert.deepEqual(encoded.subarray(188, 220), Buffer.alloc(32, 0x55));
  assertHex(encoded.subarray(220, 228), "0000000000000007");
  assert.deepEqual(encoded.subarray(228, 260), Buffer.alloc(32, 0x66));
  assert.equal(encoded[260], 0);
  assertHex(encoded.subarray(261, 269), "0000000000989680");
  assertHex(encoded.subarray(269, 277), "0000000001312d00");
  for (const terminal of [1, 2]) {
    const receipt = receiptBytes(goldenReceipt(terminal));
    assert.equal(receipt.length, 49);
    assert.equal(receipt.subarray(0, 8).toString("ascii"), "CCSLRC01");
    assertHex(receipt.subarray(8, 40), GOLDEN_TERMS_HASH);
    assert.equal(receipt[40], terminal);
    assertHex(receipt.subarray(41, 49), terminal === 1 ? "0000000001312d00" : "0000000000000000");
  }
});

test("asymmetric integers are big-endian across their complete widths", () => {
  const base = withDomain(goldenTerms(), {
    chainId: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20n,
  });
  const terms: Terms = {
    ...base,
    identity: { ...base.identity, nonce: 0x0102030405060708n },
    outcome: 0x9a,
    cashAmount: 0x1122334455667788n,
    minimumShares: 0x8877665544332211n,
  };
  const identity = identityBytes(terms.identity);
  const encoded = termsBytes(terms);
  for (const bytes of [identity, encoded]) {
    assertHex(bytes.subarray(104, 136), "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
  }
  assertHex(identity.subarray(188, 196), "0102030405060708");
  assertHex(encoded.subarray(220, 228), "0102030405060708");
  assert.equal(encoded[260], 0x9a);
  assertHex(encoded.subarray(261, 269), "1122334455667788");
  assertHex(encoded.subarray(269, 277), "8877665544332211");
  assertHex(receiptBytes({ ...goldenReceipt(), filledQuantity: 0xfedcba9876543210n }).subarray(41), "fedcba9876543210");
  const narrowed = withDomain(terms, { chainId: terms.identity.domain.chainId & MAX_U64 });
  assert.notDeepEqual(orderId(terms.identity), orderId(narrowed.identity));
  assert.notDeepEqual(termsHash(terms), termsHash(narrowed));
});

test("uint256 zero, maximum, and the highest bit retain all 32 bytes", () => {
  for (const [chainId, expected] of [
    [0n, "0000000000000000000000000000000000000000000000000000000000000000"],
    [MAX_U256, "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    [1n << 255n, "8000000000000000000000000000000000000000000000000000000000000000"],
  ] as const) {
    const terms = withDomain(goldenTerms(), { chainId });
    assertHex(identityBytes(terms.identity).subarray(104, 136), expected);
    assertHex(termsBytes(terms).subarray(104, 136), expected);
    assert.equal(orderId(terms.identity).length, 32);
    assert.equal(termsHash(terms).length, 32);
  }
});

test("uint64 zero and maximum, and uint8 outcome zero and 255, remain encodable", () => {
  for (const [value, expected] of [[0n, "0000000000000000"], [MAX_U64, "ffffffffffffffff"]] as const) {
    const base = goldenTerms();
    for (const outcome of [0, 255]) {
      const terms = { ...base, identity: { ...base.identity, nonce: value }, cashAmount: value, minimumShares: value, outcome };
      assertHex(identityBytes(terms.identity).subarray(188), expected);
      const encoded = termsBytes(terms);
      for (const offset of [220, 261, 269]) assertHex(encoded.subarray(offset, offset + 8), expected);
      assert.equal(encoded[260], outcome);
      assert.equal(orderId(terms.identity).length, 32);
      assert.equal(termsHash(terms).length, 32);
    }
    for (const terminal of [1, 2]) {
      const receipt = { ...goldenReceipt(terminal), filledQuantity: value };
      assertHex(receiptBytes(receipt).subarray(41), expected);
      assert.equal(receiptHash(receipt).length, 32);
    }
  }
});

// Runtime casts deliberately bypass static types to exercise the API boundary.
type FieldCase = {
  readonly name: string;
  readonly width: number;
  readonly calls: (value: unknown) => readonly (() => Buffer)[];
};
const domainByteFields = ["sourceDomain", "destinationDomain", "solanaProgram", "settlement"] as const;
const byteFields: readonly FieldCase[] = [
  ...domainByteFields.map((name) => ({
    name,
    width: name === "settlement" ? 20 : 32,
    calls(value: unknown) {
      const terms = withDomain(goldenTerms(), { [name]: value as Uint8Array });
      return [() => identityBytes(terms.identity), () => orderId(terms.identity), () => termsBytes(terms), () => termsHash(terms)];
    },
  })),
  { name: "user", width: 32, calls(value) {
    const base = goldenTerms();
    const terms = { ...base, identity: { ...base.identity, user: value as Uint8Array } };
    return [() => identityBytes(terms.identity), () => orderId(terms.identity), () => termsBytes(terms), () => termsHash(terms)];
  } },
  { name: "market", width: 32, calls(value) {
    const terms = { ...goldenTerms(), market: value as Uint8Array };
    return [() => termsBytes(terms), () => termsHash(terms)];
  } },
  { name: "termsHash", width: 32, calls(value) {
    const receipt = { ...goldenReceipt(), termsHash: value as Uint8Array };
    return [() => receiptBytes(receipt), () => receiptHash(receipt)];
  } },
];

for (const field of byteFields) {
  test(`${field.name} rejects wrong widths and non-byte inputs`, () => {
    const invalid: readonly unknown[] = [
      new Uint8Array(field.width - 1), new Uint8Array(field.width + 1),
      Buffer.alloc(field.width - 1), Buffer.alloc(field.width + 1),
      "0x" + "11".repeat(field.width), "11".repeat(field.width),
      "1".repeat(field.width), Array(field.width).fill(1),
      new ArrayBuffer(field.width), new Uint16Array(field.width),
      new DataView(new ArrayBuffer(field.width)), null, undefined, {}, 1,
    ];
    for (const value of invalid) {
      for (const run of field.calls(value)) assertEncodingError(run, "InvalidBytes", field.name);
    }
  });
}

test("every byte field preserves leading zeros and accepts Buffer and Uint8Array views", () => {
  const base = goldenTerms();
  const spans: readonly (readonly [number, number])[] = [[8, 40], [40, 72], [72, 104], [136, 156], [188, 220], [228, 260]];
  for (const useBuffer of [false, true]) {
    const raw = (width: number): Uint8Array => {
      // Nonzero sentinels outside the view detect encoding of the whole backing buffer.
      const backing = useBuffer ? Buffer.alloc(width + 2, 0xee) : new Uint8Array(width + 2).fill(0xee);
      const view = backing.subarray(1, width + 1);
      view.fill(0);
      view[width - 1] = 0x7a;
      return view;
    };
    const terms: Terms = {
      ...base,
      identity: { ...base.identity, user: raw(32), domain: {
        ...base.identity.domain, sourceDomain: raw(32), destinationDomain: raw(32), solanaProgram: raw(32), settlement: raw(20),
      } },
      market: raw(32),
    };
    const encoded = termsBytes(terms);
    for (const [start, end] of spans) {
      assert.deepEqual(encoded.subarray(start, end - 1), Buffer.alloc(end - start - 1));
      assert.equal(encoded[end - 1], 0x7a);
    }
    const identity = identityBytes(terms.identity);
    assert.deepEqual(identity.subarray(8, 156), encoded.subarray(8, 156));
    assert.deepEqual(identity.subarray(156, 188), encoded.subarray(188, 220));
    const receipt = { ...goldenReceipt(), termsHash: raw(32) };
    assert.deepEqual(receiptBytes(receipt).subarray(8, 39), Buffer.alloc(31));
    assert.equal(receiptBytes(receipt)[39], 0x7a);
    for (const hash of [orderId(terms.identity), termsHash(terms), receiptHash(receipt)]) assert.equal(hash.length, 32);
  }
});

const bigintFields: readonly FieldCase[] = [
  { name: "chainId", width: 32, calls(value) {
    const terms = withDomain(goldenTerms(), { chainId: value as bigint });
    return [() => identityBytes(terms.identity), () => orderId(terms.identity), () => termsBytes(terms), () => termsHash(terms)];
  } },
  { name: "nonce", width: 8, calls(value) {
    const base = goldenTerms();
    const terms = { ...base, identity: { ...base.identity, nonce: value as bigint } };
    return [() => identityBytes(terms.identity), () => orderId(terms.identity), () => termsBytes(terms), () => termsHash(terms)];
  } },
  ...(["cashAmount", "minimumShares"] as const).map((name) => ({
    name, width: 8, calls(value: unknown) {
      const terms = { ...goldenTerms(), [name]: value as bigint };
      return [() => termsBytes(terms), () => termsHash(terms)];
    },
  })),
  { name: "filledQuantity", width: 8, calls(value) {
    const receipt = { ...goldenReceipt(), filledQuantity: value as bigint };
    return [() => receiptBytes(receipt), () => receiptHash(receipt)];
  } },
];

for (const field of bigintFields) {
  test(`${field.name} rejects negative, overflowing, and non-bigint values`, () => {
    const invalid: readonly unknown[] = [
      -1n, 1n << BigInt(field.width * 8), (1n << BigInt(field.width * 8)) + 1n,
      0, 7, Number.MAX_SAFE_INTEGER, 1.5, NaN, Infinity, "0", "7", "0x07",
      true, null, undefined, {}, Object(7n),
    ];
    for (const value of invalid) {
      for (const run of field.calls(value)) assertEncodingError(run, "InvalidInteger", field.name);
    }
  });
}

for (const field of ["outcome", "terminal"] as const) {
  test(`${field} rejects malformed uint8 values with InvalidInteger`, () => {
    const invalid: readonly unknown[] = [-1, 256, 1.5, NaN, Infinity, -Infinity, "1", 1n, true, null, undefined, {}, Object(1)];
    for (const value of invalid) {
      const terms = { ...goldenTerms(), outcome: value as number };
      const receipt = { ...goldenReceipt(), terminal: value as number };
      const runs = field === "outcome"
        ? [() => termsBytes(terms), () => termsHash(terms)]
        : [() => receiptBytes(receipt), () => receiptHash(receipt)];
      for (const run of runs) assertEncodingError(run, "InvalidInteger", field);
    }
  });
}

test("all 254 unsupported uint8 terminals fail through both receipt functions", () => {
  let rejected = 0;
  for (let terminal = 0; terminal <= 255; terminal += 1) {
    if (terminal === 1 || terminal === 2) continue;
    const receipt = goldenReceipt(terminal);
    assertEncodingError(() => receiptBytes(receipt), "InvalidTerminal", `terminal ${terminal}`);
    assertEncodingError(() => receiptHash(receipt), "InvalidTerminal", `terminal ${terminal}`);
    rejected += 1;
  }
  assert.equal(rejected, 254);
});

test("every identity field binds both order ID and terms hash", () => {
  const base = goldenTerms();
  const variants: readonly Terms[] = [
    ...domainByteFields.map((field) => {
      const bytes = base.identity.domain[field].slice();
      bytes[0] ^= 1;
      return withDomain(base, { [field]: bytes });
    }),
    withDomain(base, { chainId: base.identity.domain.chainId + (1n << 200n) }),
    { ...base, identity: { ...base.identity, user: new Uint8Array(32).fill(0x56) } },
    { ...base, identity: { ...base.identity, nonce: 8n } },
  ];
  assert.equal(variants.length, 7);
  for (const changed of variants) {
    assert.notDeepEqual(identityBytes(changed.identity), identityBytes(base.identity));
    assert.notDeepEqual(orderId(changed.identity), Buffer.from(GOLDEN_ORDER_ID, "hex"));
    assert.notDeepEqual(termsHash(changed), Buffer.from(GOLDEN_TERMS_HASH, "hex"));
    assert.deepEqual(termsBytes(changed).subarray(156, 188), orderId(changed.identity));
  }
});

test("every terms-only field changes terms hash while preserving order ID", () => {
  const base = goldenTerms();
  for (const changed of [
    { ...base, market: new Uint8Array(32).fill(0x67) },
    { ...base, outcome: 1 },
    { ...base, cashAmount: 10_000_001n },
    { ...base, minimumShares: 20_000_001n },
  ]) {
    assertHex(orderId(changed.identity), GOLDEN_ORDER_ID);
    assertHex(identityBytes(changed.identity), GOLDEN_IDENTITY_BYTES);
    assert.notDeepEqual(termsBytes(changed), Buffer.from(GOLDEN_TERMS_BYTES, "hex"));
    assert.notDeepEqual(termsHash(changed), Buffer.from(GOLDEN_TERMS_HASH, "hex"));
  }
});

test("every receipt field changes its preimage and hash", () => {
  const base = goldenReceipt();
  for (const changed of [
    { ...base, termsHash: new Uint8Array(32) },
    { ...base, terminal: 2 },
    { ...base, filledQuantity: 20_000_001n },
  ]) {
    assert.notDeepEqual(receiptBytes(changed), Buffer.from(GOLDEN_FILLED_BYTES, "hex"));
    assert.notDeepEqual(receiptHash(changed), Buffer.from(GOLDEN_FILLED_HASH, "hex"));
  }
});

test("representation-valid business-invalid terms and receipt quantities are encodable", () => {
  const base = goldenTerms();
  // Includes zero amounts, cash above the creation bound, non-YES, and unmet output.
  for (const terms of [
    { ...base, cashAmount: 0n, minimumShares: 0n },
    { ...base, cashAmount: MAX_U64 },
    { ...base, outcome: 255, minimumShares: MAX_U64 },
  ]) {
    assert.equal(termsBytes(terms).length, 277);
    assert.equal(termsHash(terms).length, 32);
  }
  for (const receipt of [
    { ...goldenReceipt(1), filledQuantity: 0n },
    { ...goldenReceipt(2), filledQuantity: 1n },
    { ...goldenReceipt(1), termsHash: new Uint8Array(32), filledQuantity: MAX_U64 },
  ]) {
    assert.equal(receiptBytes(receipt).length, 49);
    assert.equal(receiptHash(receipt).length, 32);
  }
});

test("all six functions preserve input objects and arrays on success and error", () => {
  const terms = goldenTerms();
  const receipt = goldenReceipt();
  // Freeze object structure; snapshots also check mutable typed-array contents.
  Object.freeze(terms.identity.domain);
  Object.freeze(terms.identity);
  Object.freeze(terms);
  Object.freeze(receipt);
  const termsBefore = goldenTerms();
  const receiptBefore = goldenReceipt();
  const successRuns = [
    () => identityBytes(terms.identity), () => orderId(terms.identity),
    () => termsBytes(terms), () => termsHash(terms),
    () => receiptBytes(receipt), () => receiptHash(receipt),
  ];
  for (const run of successRuns) {
    run();
    assert.deepEqual(terms, termsBefore);
    assert.deepEqual(receipt, receiptBefore);
  }
  const badIdentity: Identity = Object.freeze({ ...terms.identity, nonce: -1n });
  const badTerms: Terms = Object.freeze({ ...terms, minimumShares: MAX_U64 + 1n });
  const badReceipt: Receipt = Object.freeze({ ...receipt, filledQuantity: -1n });
  const badIdentityBefore = { ...termsBefore.identity, nonce: -1n };
  const badTermsBefore = { ...termsBefore, minimumShares: MAX_U64 + 1n };
  const badReceiptBefore = { ...receiptBefore, filledQuantity: -1n };
  for (const run of [
    () => identityBytes(badIdentity), () => orderId(badIdentity),
    () => termsBytes(badTerms), () => termsHash(badTerms),
    () => receiptBytes(badReceipt), () => receiptHash(badReceipt),
  ]) {
    assertEncodingError(run, "InvalidInteger", "input preservation");
    assert.deepEqual(badIdentity, badIdentityBefore);
    assert.deepEqual(badTerms, badTermsBefore);
    assert.deepEqual(badReceipt, badReceiptBefore);
    assert.deepEqual(terms, termsBefore);
    assert.deepEqual(receipt, receiptBefore);
  }
});

test("all results own fresh memory independent of inputs and other or future results", () => {
  const terms = goldenTerms();
  const receipt = goldenReceipt();
  const inputs = [
    ...domainByteFields.map((field) => terms.identity.domain[field]),
    terms.identity.user, terms.market, receipt.termsHash,
  ];
  const runs = [
    () => identityBytes(terms.identity), () => orderId(terms.identity),
    () => termsBytes(terms), () => termsHash(terms),
    () => receiptBytes(receipt), () => receiptHash(receipt),
  ];
  const results = runs.map((run) => run());
  const snapshots = results.map((bytes) => Buffer.from(bytes));
  for (let index = 0; index < runs.length; index += 1) {
    const mutated = runs[index]();
    assert.ok(Buffer.isBuffer(mutated));
    for (const bytes of [...inputs, ...results]) assert.notEqual(mutated.buffer, bytes.buffer);
    mutated.fill(0xff);
    assert.deepEqual(terms, goldenTerms());
    assert.deepEqual(receipt, goldenReceipt());
    for (let other = 0; other < runs.length; other += 1) {
      assert.deepEqual(results[other], snapshots[other]);
      assert.deepEqual(runs[other](), snapshots[other]);
    }
  }
  // Caller mutations after encoding cannot alter already returned preimages/hashes.
  for (const bytes of inputs) bytes.fill(0);
  for (let index = 0; index < results.length; index += 1) assert.deepEqual(results[index], snapshots[index]);
});
