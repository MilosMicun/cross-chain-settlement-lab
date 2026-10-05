import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { Bytes32Hex, EvmAddressHex, FinalizedPendingOrder, FinalizedCancellationRequest, FinalizedRecoveryOrder } from "../source-order.ts";
import type { TerminalObservationResult } from "../terminal-observation.ts";
import type { BuildAcceptFilledInstructionInput } from "../filled-delivery.ts";
const { buildAcceptFilledInstruction } = await import(new URL("../filled-delivery.ts", import.meta.url).href) as typeof import("../filled-delivery.ts");
const { AnchorProvider, BorshInstructionCoder, Program } = anchor;
const idl: SettlementLab = JSON.parse(readFileSync(new URL("../../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8"));

// Public synthetic snapshots, independent SPEC preimages and manual Config/Borsh
// layouts. No production encoder, source reader or existing test suite is used.
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
const user = key(0x55), operator = key(0x81), executor = key(0xc1);
const cashMint = key(0x71), yesMint = key(0x72);
const U64_MAX = (1n << 64n) - 1n;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const raw = (hex: string) => Buffer.from(hex.slice(2), "hex");
function assertBytes32(value: string): asserts value is Bytes32Hex { assert.match(value, /^0x[0-9a-f]{64}$/); }
function assertAddress(value: string): asserts value is EvmAddressHex { assert.match(value, /^0x[0-9a-f]{40}$/); }
function hex32(bytes: Uint8Array): Bytes32Hex {
  const value = `0x${Buffer.from(bytes).toString("hex")}`;
  assertBytes32(value); return value;
}
function address(byte: number): EvmAddressHex {
  const value = `0x${Buffer.alloc(20, byte).toString("hex")}`;
  assertAddress(value); return value;
}
function uint(value: bigint, width: number, little = false): Buffer {
  assert.ok(value >= 0n && value < (1n << BigInt(width * 8)));
  const bytes = Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
  return little ? bytes.reverse() : bytes;
}
const deployment = {
  sourceDomain: hex32(Buffer.alloc(32, 0x11)), destinationDomain: hex32(Buffer.alloc(32, 0x22)),
  solanaProgram: hex32(programId.toBytes()), chainId: "31337", settlement: address(0x44), market: hex32(Buffer.alloc(32, 0x66)),
  venue: address(0x91), cashToken: address(0x92), yesToken: address(0x93), evmOperator: address(0x94), evmExecutor: address(0x95),
} satisfies SharedConfiguration;
type RecoveryPending = Extract<FinalizedRecoveryOrder, { state: "Pending" }>;
type RecoveryCancellation = Extract<FinalizedRecoveryOrder, { state: "CancelRequested" }>;
type Form = "legacy" | "recoveryPending" | "cancellationReader" | "recoveryCancellation";

// These assignments are checked by tsc and are never executed. Normal lifecycle
// narrowing passes reader results directly, without relabelling or casting.
function compileTimeLifecycleChecks(source: FinalizedRecoveryOrder, rest: Omit<BuildAcceptFilledInstructionInput, "sourceOrder">) {
  if (source.state === "Pending" || source.state === "CancelRequested") {
    const active: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
    void active;
  }
  if (source.state === "Pending") {
    const pending: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
    void pending;
  } else if (source.state === "CancelRequested") {
    const cancellation: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
    void cancellation;
  } else if (source.state === "Settled") {
    // @ts-expect-error A Settled recovery snapshot cannot authorize active delivery.
    const settled: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
    void settled;
  } else {
    // @ts-expect-error A Refunded recovery snapshot cannot authorize active delivery.
    const refunded: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
    void refunded;
  }
  // @ts-expect-error An unnarrowed recovery result may be terminal.
  const unnarrowed: BuildAcceptFilledInstructionInput = { ...rest, sourceOrder: source };
  void unnarrowed;
}
void compileTimeLifecycleChecks;

function fixture(form: Form = "recoveryCancellation", options: { nonce?: bigint; cash?: bigint; minimum?: bigint; donation?: bigint } = {}) {
  const nonce = options.nonce ?? 7n, cash = options.cash ?? 10_000_000n, minimum = options.minimum ?? 20_000_000n;
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId);
  const [config, configBump] = pda(Buffer.from("config"));
  const [accounting, accountingBump] = pda(Buffer.from("accounting"), config.toBytes());
  const [yesAuthority, yesBump] = pda(Buffer.from("yes-authority"), config.toBytes());
  const [userNonce] = pda(Buffer.from("user"), config.toBytes(), user.toBytes());
  const [order] = pda(Buffer.from("order"), config.toBytes(), user.toBytes(), uint(nonce, 8));
  const [escrow] = pda(Buffer.from("escrow"), order.toBytes());
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCashAta = ata(cashMint, user), userYesAta = ata(yesMint, user), executorCashAta = ata(cashMint, executor);
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([programId.toBytes()], loader);
  const domain = Buffer.concat([raw(deployment.sourceDomain), raw(deployment.destinationDomain), programId.toBuffer(), uint(31337n, 32), raw(deployment.settlement)]);
  const identityBytes = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
  const orderId = sha(identityBytes);
  const termsBytes = Buffer.concat([Buffer.from("CCSLTR01"), domain, orderId, user.toBuffer(), uint(nonce, 8), raw(deployment.market),
    Buffer.from([0]), uint(cash, 8), uint(minimum, 8)]);
  const termsHash = sha(termsBytes);
  const quantity = cash * 2n;
  const receiptBytes = Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([1]), uint(quantity, 8)]);
  assert.deepEqual([domain.length, identityBytes.length, termsBytes.length, receiptBytes.length], [148, 196, 277, 49]);
  const configBytes = Buffer.concat([sha(Buffer.from("account:Config")).subarray(0, 8), Buffer.from([1]),
    raw(deployment.sourceDomain), raw(deployment.destinationDomain), programId.toBuffer(), uint(31337n, 32),
    ...[deployment.settlement, deployment.venue, deployment.cashToken, deployment.yesToken, deployment.evmOperator, deployment.evmExecutor].map(raw),
    raw(deployment.market), Buffer.from([0]),
    ...[operator, executor, cashMint, yesMint, executorCashAta, yesAuthority, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId].map((k) => k.toBuffer()),
    Buffer.from([configBump, yesBump])]);
  assert.equal(configBytes.length, 580);
  const expectedConfiguration: LiveConfigurationObservation = {
    scope: "Public synthetic snapshots; no live verification claim",
    evm: { blockNumber: 12, blockHash: hex32(Buffer.alloc(32, 0xcc)), rpcChainId: "31337", configuration: { ...deployment },
      venue: { cashToken: deployment.cashToken, yesToken: deployment.yesToken, market: deployment.market },
      tokenDecimals: { cash: "6", yes: "6" }, codeBytes: {} },
    solana: { contextSlot: 100, minContextSlot: 90, commitment: "finalized", configuration: { ...deployment },
      config: { address: config.toBase58(), owner: programId.toBase58(), dataHex: configBytes.toString("hex"), version: 1, outcome: 0,
        bump: configBump, yesAuthorityBump: yesBump, operator: operator.toBase58(), executor: executor.toBase58(),
        cashMint: cashMint.toBase58(), yesMint: yesMint.toBase58(), executorCashAta: executorCashAta.toBase58(), yesAuthority: yesAuthority.toBase58(),
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(), associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), systemProgram: SystemProgram.programId.toBase58() },
      accounting: { address: accounting.toBase58(), owner: programId.toBase58(), config: config.toBase58(), bump: accountingBump, counters: [cash.toString(), "0", "0", "0"] },
      mints: { cash: { address: cashMint.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: operator.toBase58(), freezeAuthority: null, supply: cash.toString() },
        yes: { address: yesMint.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: yesAuthority.toBase58(), freezeAuthority: null, supply: "0" } },
      executorCashAta: { address: executorCashAta.toBase58(), owner: executor.toBase58(), mint: cashMint.toBase58(), amount: "0" },
      program: { address: programId.toBase58(), owner: loader.toBase58(), executable: true, programData: programData.toBase58(),
        programDataOwner: loader.toBase58(), deploymentSlot: "1", upgradeAuthority: null, loadedImageSha256: "ab".repeat(32) } },
  };
  const legacy: FinalizedPendingOrder = {
    accounts: { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
      userCashAta: userCashAta.toBase58(), userYesAta: userYesAta.toBase58() },
    contextSlot: 123, state: "Pending", orderId: hex32(orderId), termsHash: hex32(termsHash), escrowBalance: cash + (options.donation ?? 0n),
    terms: { identity: { domain: { sourceDomain: deployment.sourceDomain, destinationDomain: deployment.destinationDomain,
      solanaProgram: deployment.solanaProgram, chainId: 31337n, settlement: deployment.settlement }, user: hex32(user.toBytes()), nonce },
      market: deployment.market, outcome: 0, cashAmount: cash, minimumShares: minimum },
  };
  const recoveryPending: RecoveryPending = { ...structuredClone(legacy), cancellationRequested: false, acceptedReceipt: null };
  const cancellationReader: FinalizedCancellationRequest = { ...structuredClone(legacy), state: "CancelRequested", cancellationRequested: true };
  const recoveryCancellation: RecoveryCancellation = { ...structuredClone(cancellationReader), acceptedReceipt: null };
  const forms = { legacy, recoveryPending, cancellationReader, recoveryCancellation };
  const observation: Extract<TerminalObservationResult, { kind: "Confirmed" }> = {
    kind: "Confirmed", orderId: legacy.orderId, termsHash: legacy.termsHash, terms: structuredClone(legacy.terms),
    receipt: { termsHash: legacy.termsHash, terminal: 1, filledQuantity: quantity }, receiptHash: hex32(sha(receiptBytes)),
    transactionHash: hex32(Buffer.alloc(32, 0xaa)), inclusion: { number: 10n, hash: hex32(Buffer.alloc(32, 0xbb)) },
    observationHead: { number: 12n, hash: hex32(Buffer.alloc(32, 0xcc)) }, additionalBlocks: 2n,
  };
  const calls = { rpc: 0, walletSigning: 0, providerSubmission: 0 };
  const rejectIO = (category: keyof typeof calls) => async () => { calls[category]++; throw new Error(`Forbidden ${category}`); };
  const connection = new Proxy(new Connection("http://127.0.0.1:18899", { commitment: "finalized", fetch: rejectIO("rpc") }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? rejectIO("rpc") : value;
    },
  });
  const wallet = { publicKey: operator, signTransaction: rejectIO("walletSigning"), signAllTransactions: rejectIO("walletSigning") };
  const provider = new Proxy(new AnchorProvider(connection, wallet, { commitment: "finalized" }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? rejectIO("providerSubmission") : value;
    },
  });
  const client = new Program<SettlementLab>(structuredClone(idl), provider);
  const input: BuildAcceptFilledInstructionInput = { program: client, expectedConfiguration, sourceOrder: forms[form], observation };
  const instructionBytes = Buffer.concat([sha(Buffer.from("global:accept_filled")).subarray(0, 8), domain, user.toBuffer(), uint(nonce, 8, true),
    raw(deployment.market), Buffer.from([0]), uint(cash, 8, true), uint(minimum, 8, true), termsHash, Buffer.from([1]), uint(quantity, 8, true)]);
  const expectedMetas = [operator, user, config, accounting, userNonce, order, cashMint, yesMint, userYesAta, escrow, executorCashAta, yesAuthority, TOKEN_PROGRAM_ID]
    .map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: [3, 5, 7, 8, 9, 10].includes(index) }));
  return { input, forms, observation, instructionBytes, expectedMetas, calls };
}
type Fixture = ReturnType<typeof fixture>;
const snapshots = (f: Fixture) => structuredClone({ sourceOrder: f.input.sourceOrder, expectedConfiguration: f.input.expectedConfiguration, observation: f.input.observation });
const assertNoIO = (f: Fixture) => assert.deepEqual(f.calls, { rpc: 0, walletSigning: 0, providerSubmission: 0 });
async function verifyInstruction(f: Fixture) {
  const before = snapshots(f);
  const ix = await buildAcceptFilledInstruction(f.input);
  assert.deepEqual(snapshots(f), before, "Success preserves caller snapshots");
  assert.ok(ix.programId.equals(programId));
  assert.equal(ix.data.length, 286);
  assert.deepEqual(ix.data, f.instructionBytes, "Independent Borsh discriminator, field order, widths and endianness");
  assert.equal(ix.keys.length, 13);
  assert.deepEqual(ix.keys, f.expectedMetas, "Exact account order, signer and writable flags");
  const coder = f.input.program.coder.instruction;
  assert.ok(coder instanceof BorshInstructionCoder);
  assert.equal(coder.decode(ix.data)?.name, "acceptFilled");
  assertNoIO(f);
  return ix;
}
async function reject(f: Fixture, reason: string) {
  const before = snapshots(f);
  await assert.rejects(buildAcceptFilledInstruction(f.input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith("Invalid Filled delivery: "), error.message);
    assert.ok(error.message.includes(reason), error.message);
    return true;
  });
  assert.deepEqual(snapshots(f), before, "Rejection preserves caller snapshots");
  assertNoIO(f);
}
// Malformed-input casts are confined to this negative-test mutation helper.
function malformed(f: Fixture, path: string, value: unknown) {
  const parts = path.split(".");
  let record = f.input as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) record = record[part] as Record<string, unknown>;
  record[parts.at(-1)!] = value;
}

for (const form of ["legacy", "recoveryPending", "cancellationReader", "recoveryCancellation"] satisfies Form[]) {
  test(`${form} encodes the real acceptFilled instruction and exact 13 account metas`, async () => { await verifyInstruction(fixture(form)); });
}
test("equivalent terms across all four source forms produce byte-for-byte identical instructions", async () => {
  const f = fixture();
  const before = structuredClone(f.forms);
  const results = [];
  for (const sourceOrder of Object.values(f.forms)) results.push(await buildAcceptFilledInstruction({ ...f.input, sourceOrder }));
  for (const ix of results) {
    assert.deepEqual(ix, results[0]); assert.deepEqual(ix.data, f.instructionBytes); assert.deepEqual(ix.keys, f.expectedMetas);
  }
  assert.deepEqual(f.forms, before); assertNoIO(f);
});
for (const [label, options] of [
  ["minimum amounts and zero nonce", { cash: 1n, minimum: 1n, nonce: 0n }],
  ["maximum cash/full-fill and last usable nonce", { cash: U64_MAX / 2n, minimum: U64_MAX - 1n, nonce: U64_MAX - 1n }],
  ["nontrivial nonce distinguishes PDA big endian from Borsh little endian", { nonce: 0x0102030405060708n }],
  ["unsolicited donation remains in the snapshot", { donation: 123n }],
  ["maximum uint64 escrow includes retained donations", { donation: U64_MAX - 10_000_000n }],
] as const) test(label, async () => {
  const f = fixture("recoveryCancellation", options);
  await verifyInstruction(f);
  assert.equal(f.input.sourceOrder.escrowBalance - f.input.sourceOrder.terms.cashAmount, "donation" in options ? options.donation : 0n);
});
test("retained donation changes neither instruction bytes nor account metas", async () => {
  const normal = await verifyInstruction(fixture()), donated = await verifyInstruction(fixture("recoveryCancellation", { donation: 999n }));
  assert.deepEqual(donated, normal);
});
test("input ownership is preserved before asynchronous instruction construction", async () => {
  const f = fixture(), client = f.input.program, original = client.methods.acceptFilled;
  let release: () => void = () => assert.fail("Construction gate is unavailable");
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  client.methods.acceptFilled = (args) => {
    entered++;
    const builder = original(args), instruction = builder.instruction.bind(builder);
    builder.instruction = async () => { await gate; return instruction(); };
    return builder;
  };
  const building = buildAcceptFilledInstruction(f.input);
  assert.equal(entered, 1, "The supplied Program is retained");
  f.input.sourceOrder.terms.cashAmount = 1n;
  f.input.sourceOrder.accounts.escrow = PublicKey.default.toBase58();
  f.observation.receipt.filledQuantity = 17n;
  f.input.expectedConfiguration.solana.config.operator = PublicKey.default.toBase58();
  const callerChanges = snapshots(f);
  release();
  const ix = await building;
  assert.deepEqual(ix.data, f.instructionBytes); assert.deepEqual(ix.keys, f.expectedMetas);
  assert.deepEqual(snapshots(f), callerChanges, "Construction never overwrites subsequent caller changes");
  assertNoIO(f);
});
test("repeated construction produces independent output buffers without changing snapshots", async () => {
  const f = fixture(), before = snapshots(f);
  const first = await verifyInstruction(f), second = await verifyInstruction(f);
  assert.deepEqual(first, second); assert.notStrictEqual(first.data, second.data); assert.notStrictEqual(first.keys, second.keys);
  first.data.fill(0); first.keys[0].isSigner = false;
  assert.deepEqual(second.data, f.instructionBytes); assert.deepEqual(second.keys, f.expectedMetas);
  assert.deepEqual(snapshots(f), before); assertNoIO(f);
});

for (const form of ["legacy", "recoveryPending"] satisfies Form[]) {
  for (const flag of [true, 1, "false", null, undefined]) test(`${form} rejects present inconsistent Pending cancellation flag ${String(flag)}`, async () => {
    const f = fixture(form); malformed(f, "sourceOrder.cancellationRequested", flag); await reject(f, "inconsistent cancellationRequested");
  });
}
for (const form of ["cancellationReader", "recoveryCancellation"] satisfies Form[]) {
  for (const flag of [false, 1, "true", null, undefined]) test(`${form} rejects inconsistent CancelRequested flag ${String(flag)}`, async () => {
    const f = fixture(form); malformed(f, "sourceOrder.cancellationRequested", flag); await reject(f, "inconsistent cancellationRequested");
  });
  test(`${form} rejects an absent cancellation flag`, async () => {
    const f = fixture(form); Reflect.deleteProperty(f.input.sourceOrder, "cancellationRequested"); await reject(f, "inconsistent cancellationRequested");
  });
}
for (const form of ["legacy", "recoveryPending", "cancellationReader", "recoveryCancellation"] satisfies Form[]) {
  for (const receipt of [{ terminal: 1, filledQuantity: 20_000_000n, receiptHash: hex32(Buffer.alloc(32, 0xab)) }, false, undefined]) {
    test(`${form} rejects non-null accepted receipt ${String(receipt)}`, async () => {
      const f = fixture(form); malformed(f, "sourceOrder.acceptedReceipt", receipt); await reject(f, "active acceptedReceipt must be null");
    });
  }
}
for (const state of ["Settled", "Refunded", "Unseen", "pending", "Unknown", undefined]) {
  test(`reject source state ${String(state)}`, async () => {
    const f = fixture(); malformed(f, "sourceOrder.state", state); await reject(f, "expected active source state");
  });
}
test("NotConfirmed cannot authorize delivery after cancellation intent", async () => {
  const f = fixture();
  const input = { ...f.input, observation: { kind: "NotConfirmed", reason: "MissingReceipt" } satisfies TerminalObservationResult };
  await reject({ ...f, input }, "requires Confirmed/Filled");
});
test("Confirmed/Cancelled cannot authorize Filled delivery after cancellation intent", async () => {
  const f = fixture(); f.observation.receipt.terminal = 2; f.observation.receipt.filledQuantity = 0n;
  await reject(f, "requires Confirmed/Filled");
});
const wrong32 = hex32(Buffer.alloc(32, 0xfe)), zero32 = hex32(Buffer.alloc(32));
const failures: [string, unknown, string][] = [
  ...[0n, 9_999_999n, U64_MAX + 1n, 10_000_000].map((v): [string, unknown, string] => ["sourceOrder.escrowBalance", v, "funded finalized active"]),
  ...[0, 89, 1.5, Number.MAX_SAFE_INTEGER + 1].map((v): [string, unknown, string] => ["sourceOrder.contextSlot", v, v === 89 ? "source configuration accounts" : "funded finalized active"]),
  ["sourceOrder.terms.cashAmount", 0n, "amount bounds"], ["sourceOrder.terms.cashAmount", U64_MAX / 2n + 1n, "amount bounds"],
  ["sourceOrder.terms.identity.nonce", U64_MAX, "amount bounds"], ["sourceOrder.terms.minimumShares", 0n, "amount bounds"],
  ["sourceOrder.terms.minimumShares", U64_MAX + 1n, "amount bounds"], ["sourceOrder.terms.outcome", 1, "amount bounds"],
  ["observation.terms.minimumShares", 19_999_999n, "complete terms"], ["observation.terms.identity.nonce", 8n, "complete terms"],
  ["sourceOrder.orderId", wrong32, "complete terms"], ["sourceOrder.termsHash", wrong32, "complete terms"],
  ["observation.orderId", wrong32, "complete terms"], ["observation.termsHash", wrong32, "complete terms"],
  ["observation.receipt.termsHash", wrong32, "complete terms"], ["observation.receiptHash", wrong32, "receipt hash"],
  ["observation.receipt.filledQuantity", 19_999_999n, "full-fill quantity/minimum"],
  ["observation.receipt.filledQuantity", 20_000_001n, "full-fill quantity/minimum"],
  ["observation.receipt.filledQuantity", 20_000_000, "full-fill quantity/minimum"],
  ...["transactionHash", "inclusion.hash", "observationHead.hash"].map((v): [string, unknown, string] => [`observation.${v}`, zero32, "zero confirmation identity"]),
  ["observation.additionalBlocks", 1n, "confirmation metadata"], ["observation.additionalBlocks", 2, "confirmation metadata"],
  ["observation.observationHead.number", 13n, "confirmation metadata"], ["observation.inclusion.number", -1n, "confirmation metadata"],
  ["observation.observationHead.number", 1n << 256n, "confirmation metadata"],
  ["observation.observationHead.hash", hex32(Buffer.alloc(32, 0xbb)), "confirmation metadata"],
  ["expectedConfiguration.solana.commitment", "confirmed", "source configuration accounts"],
  ["expectedConfiguration.solana.config.bump", 0, "source configuration accounts"],
  ["expectedConfiguration.solana.program.upgradeAuthority", operator.toBase58(), "source configuration accounts"],
  ["expectedConfiguration.evm.rpcChainId", "1", "shared configuration/chain"],
  ["expectedConfiguration.solana.config.dataHex", "00", "Config bytes"],
  ["expectedConfiguration.solana.config.operator", executor.toBase58(), "Config bytes solanaOperator"],
  ["expectedConfiguration.solana.config.executorCashAta", user.toBase58(), "Config bytes executorCashAta"],
  ["expectedConfiguration.solana.config.cashMint", yesMint.toBase58(), "Config bytes cashMint"],
  ["expectedConfiguration.solana.config.tokenProgram", SystemProgram.programId.toBase58(), "legacy programs"],
  ...["config", "userNonce", "order", "escrow", "userCashAta", "userYesAta"].map((v): [string, unknown, string] => [`sourceOrder.accounts.${v}`, operator.toBase58(), `source ${v}`]),
];
for (const [path, value, reason] of failures) {
  test(`CancelRequested retains validation: ${path} = ${String(value)}`, async () => {
    const f = fixture();
    malformed(f, path, value);
    if (path === "sourceOrder.terms.cashAmount" && typeof value === "bigint" && value > f.input.sourceOrder.escrowBalance) {
      f.input.sourceOrder.escrowBalance = value;
    }
    await reject(f, reason);
  });
}
test("CancelRequested rejects independently hashed, unattainable minimum", async () => {
  await reject(fixture("recoveryCancellation", { cash: 1n, minimum: 3n }), "full-fill quantity/minimum");
});
for (const field of ["sourceDomain", "destinationDomain", "settlement", "market"] as const) {
  test(`CancelRequested rejects matching configurations bound to wrong deployment ${field}`, async () => {
    const f = fixture();
    const replacement = field === "settlement" ? address(0xfe) : wrong32;
    f.input.expectedConfiguration.solana.configuration[field] = replacement;
    f.input.expectedConfiguration.evm.configuration[field] = replacement;
    await reject(f, field === "market" ? "configured market" : `deployment ${field}`);
  });
}
test("CancelRequested rejects an IDL rebound to another program", async () => {
  const f = fixture(); malformed(f, "program.idl.address", operator.toBase58()); await reject(f, "program/IDL binding");
});
test("CancelRequested rejects matching decoded Config with aliased roles", async () => {
  const f = fixture(), c = f.input.expectedConfiguration.solana.config;
  c.executor = c.operator;
  c.executorCashAta = getAssociatedTokenAddressSync(cashMint, operator, true).toBase58();
  const bytes = Buffer.from(c.dataHex, "hex");
  // Config: 8 discriminator + 1 version + 148 domain + 5*20 EVM addresses
  // + 32 market + 1 outcome; then the ordered Solana public keys.
  const solanaKeysOffset = 290;
  bytes.set(operator.toBytes(), solanaKeysOffset + 32);
  bytes.set(new PublicKey(c.executorCashAta).toBytes(), solanaKeysOffset + 4 * 32);
  c.dataHex = bytes.toString("hex");
  await reject(f, "roles/mints");
});
