import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BorshInstructionCoder, convertIdlToCamelCase, type Idl, type Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { getAddress } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaInitializeArgs } from "../solana-configuration.ts";

// URL value imports preserve the existing noEmit TypeScript configuration.
const { buildInitializeArgs } = await import(new URL("../solana-configuration.ts", import.meta.url).href) as typeof import("../solana-configuration.ts");

const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const operator = new PublicKey(Buffer.from("8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0", "hex"));
const executor = new PublicKey(Buffer.from("c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0", "hex"));

// All fixture addresses and transaction metadata are synthetic, not deployment evidence.
const manifest: EvmDeploymentManifest = {
  schemaVersion: 1,
  chainId: "31337",
  sourceDomain: "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  destinationDomain: "0xa1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0",
  solanaProgram: "0x67d68836c516e28f6fa10a3bcc609744f71f4a8f8768f58ec23064deff17a2cc",
  market: "0x4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
  outcome: 0,
  tokenDecimals: 6,
  roles: {
    deployer: "0x9192939495969798999a9b9c9d9e9fa0a1a2a3a4",
    operator: "0x8182838485868788898a8b8c8d8e8f9091929394",
    executor: "0xa1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4",
  },
  contracts: {
    settlement: "0x0102030405060708090a0b0c0d0e0f1011121314",
    venue: "0x2122232425262728292a2b2c2d2e2f3031323334",
    usd: "0x4142434445464748494a4b4c4d4e4f5051525354",
    yes: "0x6162636465666768696a6b6c6d6e6f7071727374",
  },
  funding: { executorUsd: "100000000", venueYes: "200000000", executorAllowance: "100000000" },
  transactions: {
    usdDeployment: { transactionHash: "synthetic-usd", blockNumber: 1, blockHash: "synthetic-block-1" },
    yesDeployment: { transactionHash: "synthetic-yes", blockNumber: 2, blockHash: "synthetic-block-2" },
    venueDeployment: { transactionHash: "synthetic-venue", blockNumber: 3, blockHash: "synthetic-block-3" },
    settlementDeployment: { transactionHash: "synthetic-settlement", blockNumber: 4, blockHash: "synthetic-block-4" },
    executorFunding: { transactionHash: "synthetic-cash", blockNumber: 5, blockHash: "synthetic-block-5" },
    venueFunding: { transactionHash: "synthetic-inventory", blockNumber: 6, blockHash: "synthetic-block-6" },
    executorApproval: { transactionHash: "synthetic-approval", blockNumber: 7, blockHash: "synthetic-block-7" },
  },
};

// Independent literal expectations, ordered according to Rust InitializeArgs.
// Neither the fixture nor the adapter constructs these expected bytes.
const expectedBytes = {
  sourceDomain: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  destinationDomain: "a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0",
  chainId: "0000000000000000000000000000000000000000000000000000000000007a69",
  settlement: "0102030405060708090a0b0c0d0e0f1011121314",
  venue: "2122232425262728292a2b2c2d2e2f3031323334",
  cashToken: "4142434445464748494a4b4c4d4e4f5051525354",
  yesToken: "6162636465666768696a6b6c6d6e6f7071727374",
  evmOperator: "8182838485868788898a8b8c8d8e8f9091929394",
  evmExecutor: "a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4",
  market: "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
} as const;
const expectedOperator = "8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0";
const expectedExecutor = "c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0";
const byteFields = Object.keys(expectedBytes) as (keyof typeof expectedBytes)[];

function build(input = manifest, id = programId, op = operator, ex = executor): SolanaInitializeArgs {
  return buildInitializeArgs(input, id, op, ex);
}

// Compile-time proof against the actual generated Program initialize method.
const anchorArgs: Parameters<Program<SettlementLab>["methods"]["initialize"]>[0] = build();

function patch(overrides: Record<string, unknown>): EvmDeploymentManifest {
  // Deliberately bypass static types to test malformed manifest representations.
  return { ...manifest, ...overrides } as unknown as EvmDeploymentManifest;
}

function rejects(input: EvmDeploymentManifest, error: RegExp, keys = [programId, operator, executor]): void {
  const before = structuredClone(input);
  const keyBytes = keys.map((key) => key.toBuffer().toString("hex"));
  assert.throws(() => build(input, keys[0], keys[1], keys[2]), error);
  assert.deepEqual(input, before, "Rejected conversion must not mutate the manifest");
  assert.deepEqual(keys.map((key) => key.toBuffer().toString("hex")), keyBytes);
}

test("all twelve initialize fields match independent literal bytes and public keys", () => {
  assert.deepEqual(Object.keys(anchorArgs), [...byteFields, "solanaOperator", "solanaExecutor"]);
  for (const field of byteFields) {
    assert.ok(Array.isArray(anchorArgs[field]), field);
    assert.deepEqual(anchorArgs[field], [...Buffer.from(expectedBytes[field], "hex")], field);
    assert.ok(anchorArgs[field].every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255), field);
  }
  assert.ok(anchorArgs.solanaOperator instanceof PublicKey);
  assert.ok(anchorArgs.solanaExecutor instanceof PublicKey);
  assert.equal(anchorArgs.solanaOperator.toBuffer().toString("hex"), expectedOperator);
  assert.equal(anchorArgs.solanaExecutor.toBuffer().toString("hex"), expectedExecutor);
});

test("uint256 encoding preserves values above uint64, the maximum, and the minimum", () => {
  const cases = [
    ["455867356320691211509944977504407603390036387149619137164185182714736811808",
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"],
    ["115792089237316195423570985008687907853269984665640564039457584007913129639935",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ["1", "0000000000000000000000000000000000000000000000000000000000000001"],
  ];
  for (const [chainId, expected] of cases) {
    assert.deepEqual(build(patch({ chainId })).chainId, [...Buffer.from(expected, "hex")], chainId);
  }
});

test("malformed, zero, non-string and overflowing chain IDs are rejected without mutation", () => {
  for (const chainId of [
    "", "0", "00", "031337", " 31337", "31337 ", "31337\n", "+31337", "-1", "0x7a69", "3.1337e4", "31337.0",
    31337, 31337n, new Number(31337), Object(31337n), new String("31337"), null, undefined,
  ]) rejects(patch({ chainId }), /chainId must be a canonical positive decimal string/);
  for (const chainId of [
    "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    "1" + "0".repeat(78),
  ]) rejects(patch({ chainId }), /chainId must fit uint256/);
});

test("32-byte hex fields reject wrong widths, prefixes, types and zero bytes", () => {
  for (const field of ["sourceDomain", "destinationDomain", "market", "solanaProgram"] as const) {
    for (const value of [
      "0x" + "01".repeat(31), "0x" + "01".repeat(33), "0x" + "1".repeat(63),
      "01".repeat(32), "0X" + "01".repeat(32), "0x" + "gg".repeat(32),
      manifest[field] + " ", 32, new Uint8Array(32), null, undefined,
    ]) rejects(patch({ [field]: value }), new RegExp(`${field} must be a 0x-prefixed 32-byte hex string`));
    rejects(patch({ [field]: "0x" + "00".repeat(32) }), new RegExp(`${field} must be nonzero`));
  }
});

test("equal deployment domains are rejected by decoded bytes regardless of hex case", () => {
  rejects(patch({ sourceDomain: manifest.destinationDomain }), /domains must be distinct/);
  rejects(patch({ sourceDomain: "0x" + manifest.destinationDomain.slice(2).toUpperCase() }), /domains must be distinct/);
});

test("program binding must match a supplied nonzero PublicKey", () => {
  rejects(patch({ solanaProgram: "0x" + expectedOperator }), /solanaProgram must match programId/);
  rejects(manifest, /solanaProgram must match programId/, [operator, operator, executor]);
  rejects(manifest, /programId must be a nonzero PublicKey/, [PublicKey.default, operator, executor]);
});

test("all six consumed EVM addresses reject zero and malformed representations", () => {
  for (const [group, fields] of [
    ["contracts", ["settlement", "venue", "usd", "yes"]],
    ["roles", ["operator", "executor"]],
  ] as const) {
    for (const field of fields) {
      for (const value of [
        "0x" + "00".repeat(20), "0x" + "01".repeat(19), "0x" + "01".repeat(21),
        "01".repeat(20), "0x" + "gg".repeat(20), "0x" + "1".repeat(39),
        20, new Uint8Array(20), null, undefined,
      ]) rejects(patch({ [group]: { ...manifest[group], [field]: value } }), /must be (nonzero|a 0x-prefixed 20-byte hex string)/);
    }
  }
  const checksummed = getAddress(manifest.roles.executor);
  const index = checksummed.slice(2).search(/[a-fA-F]/) + 2;
  const letter = checksummed[index];
  const badChecksum = checksummed.slice(0, index)
    + (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()) + checksummed.slice(index + 1);
  rejects(patch({ roles: { ...manifest.roles, executor: badChecksum } }), /evmExecutor must be a valid EVM address/);
});

test("checksummed and uppercase hex preserve decoded bytes", () => {
  const result = build(patch({
    sourceDomain: "0x" + manifest.sourceDomain.slice(2).toUpperCase(),
    solanaProgram: "0x" + manifest.solanaProgram.slice(2).toUpperCase(),
    roles: { ...manifest.roles, operator: getAddress(manifest.roles.operator) },
  }));
  assert.deepEqual(result, anchorArgs);
});

test("aliased EVM token addresses and roles are rejected across hex case", () => {
  for (const uppercase of [false, true]) {
    const alias = (value: string) => uppercase ? "0x" + value.slice(2).toUpperCase() : value;
    rejects(patch({ contracts: { ...manifest.contracts, yes: alias(manifest.contracts.usd) } }), /EVM cash and YES tokens must be distinct/);
    rejects(patch({ roles: { ...manifest.roles, executor: alias(manifest.roles.operator) } }), /EVM operator and executor must be distinct/);
  }
});

test("zero and aliased Solana roles are rejected without mutating supplied keys", () => {
  rejects(manifest, /solanaOperator must be a nonzero PublicKey/, [programId, PublicKey.default, executor]);
  rejects(manifest, /solanaExecutor must be a nonzero PublicKey/, [programId, operator, PublicKey.default]);
  rejects(manifest, /Solana operator and executor must be distinct/, [programId, operator, new PublicKey(operator.toBytes())]);
});

test("unsupported schema, outcome and decimals are rejected with strict types", () => {
  for (const [field, values, error] of [
    ["schemaVersion", [0, 2, "1", null, undefined], /schemaVersion must be 1/],
    ["outcome", [1, "0", null, undefined], /outcome must be 0/],
    ["tokenDecimals", [0, 18, "6", null, undefined], /tokenDecimals must be 6/],
  ] as const) {
    for (const value of values) rejects(patch({ [field]: value }), error);
  }
});

test("unrelated deployer, funding and transaction fields are not validated", () => {
  assert.deepEqual(build(patch({
    roles: { ...manifest.roles, deployer: "unrelated" }, funding: null, transactions: null,
  })), anchorArgs);
});

test("successful conversion preserves inputs and returns independent arrays for every call", () => {
  const input = structuredClone(manifest);
  const before = structuredClone(input);
  const keysBefore = [programId, operator, executor].map((key) => key.toBuffer().toString("hex"));
  const first = build(input);
  const second = build(input);
  assert.equal(new Set([...byteFields.map((field) => first[field]), ...byteFields.map((field) => second[field])]).size, 20);
  for (const field of byteFields) first[field].fill(0);
  assert.deepEqual(input, before);
  assert.deepEqual([programId, operator, executor].map((key) => key.toBuffer().toString("hex")), keysBefore);
  assert.deepEqual(second, anchorArgs);
  assert.deepEqual(build(input), anchorArgs);
});

test("generated IDL encodes the exact 320-byte Anchor initialize instruction offline", () => {
  const idl = JSON.parse(readFileSync(new URL("../../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as Idl;
  // Program uses this same conversion for the Rust-generated snake_case IDL.
  const coder = new BorshInstructionCoder(convertIdlToCamelCase(idl));
  const encoded = coder.encode("initialize", { args: build() });
  const expected = Buffer.from([
    "afaf6d1f0d989bed", ...Object.values(expectedBytes), expectedOperator, expectedExecutor,
  ].join(""), "hex");
  assert.equal(expected.length, 320);
  assert.equal(encoded.length, 320);
  assert.deepEqual(encoded.subarray(0, 8), Buffer.from("afaf6d1f0d989bed", "hex"));
  assert.deepEqual(encoded, expected, "Discriminator, field order, raw byte widths and key bytes must match");
  assert.deepEqual(encoded.subarray(72, 104), Buffer.from(expectedBytes.chainId, "hex"), "chainId is already big-endian raw bytes");
});
