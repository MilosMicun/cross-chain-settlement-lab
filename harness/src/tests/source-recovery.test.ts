import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BorshAccountsCoder, convertIdlToCamelCase, type Idl } from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { ReadFinalizedRecoveryOrderInput, SourceOrderConnection, SourceOrderErrorCode } from "../source-order.ts";
const { readFinalizedRecoveryOrder, SourceOrderError } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");

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
// Rust account offsets, not protocol preimage offsets. None bumps are at 292/293;
// Some adds 41 bytes, placing them at 333/334 in the same 335-byte allocation.
const orderOffsets = { config: 8, user: 40, nonce: 72, market: 80, outcome: 112, cash: 113,
  minimum: 121, id: 129, hash: 161, cashAta: 193, yesAta: 225, escrow: 257,
  state: 289, cancellation: 290, receipt: 291, bump: 292, escrowBump: 293 };
type FixtureOptions = { nonce?: bigint; cash?: bigint; minimum?: bigint; nextNonce?: bigint; donation?: bigint; balance?: bigint; chainId?: bigint; terminal?: number; quantity?: bigint;
  state?: 0 | 1 | 2 | 3; cancellation?: boolean; receipt?: boolean };
function fixture(options: FixtureOptions = {}) {
  const chainId = options.chainId ?? 31337n;
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
  const nonceData = Buffer.concat([Buffer.from("eb8501f3128758e0", "hex"), config.toBuffer(), user.toBuffer(), uint(options.nextNonce ?? nonce + 1n, 8, "le"), Buffer.from([userBump])]);
  const state = options.state ?? 0;
  const hasReceipt = options.receipt ?? state >= 2;
  const terminal = options.terminal ?? (state === 3 ? 2 : 1);
  const quantity = options.quantity ?? (state === 3 ? 0n : cash * 2n);
  const receiptHash = hash(Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([terminal]), uint(quantity, 8)]));
  const orderSerialized = Buffer.concat([
    Buffer.from("86addfb94d561c33", "hex"), config.toBuffer(), user.toBuffer(), uint(nonce, 8, "le"), raw(shared.market), Buffer.from([0]),
    uint(cash, 8, "le"), uint(minimum, 8, "le"), orderId, termsHash, cashAta.toBuffer(), yesAta.toBuffer(), escrow.toBuffer(),
    Buffer.from([state, Number(options.cancellation ?? (state === 1 || state === 3)), Number(hasReceipt)]),
    ...(hasReceipt ? [Buffer.from([terminal]), uint(quantity, 8, "le"), receiptHash] : []), Buffer.from([orderBump, escrowBump]),
  ]);
  const orderData = Buffer.alloc(335);
  orderSerialized.copy(orderData);
  const balance = options.balance ?? (state >= 2 ? 0n : cash + (options.donation ?? 0n));
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
    cancellationRequested: options.cancellation ?? (state === 1 || state === 3),
    acceptedReceipt: hasReceipt ? { terminal, filledQuantity: quantity, receiptHash: asHex(receiptHash) } : null, orderId: asHex(orderId), termsHash: asHex(termsHash), escrowBalance: balance,
  terms: { identity: { domain: { sourceDomain: shared.sourceDomain, destinationDomain: shared.destinationDomain, solanaProgram: shared.solanaProgram,
    chainId, settlement: shared.settlement }, user: "0x" + "55".repeat(32), nonce }, market: shared.market, outcome: 0, cashAmount: cash, minimumShares: minimum } };
  return { input, records, response, expectedOutput, addresses, orderSerialized, calls: () => calls };
}
type Fixture = ReturnType<typeof fixture>;
async function rejects(f: Fixture, code: SourceOrderErrorCode) {
  await assert.rejects(readFinalizedRecoveryOrder(f.input), (error: unknown) => {
    assert.ok(error instanceof SourceOrderError);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("manual None/Some layouts agree with the actual generated IDL", () => {
  const idl = JSON.parse(readFileSync(new URL("../../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as Idl;
  assert.equal(idl.address, program.toBase58());
  const coder = new BorshAccountsCoder(convertIdlToCamelCase(idl));
  for (const state of [0, 1, 2, 3] as const) {
    const f = fixture({ state });
    const decoded = coder.decode("order", f.records[2].data);
    assert.equal(Object.keys(decoded.state)[0], ["pending", "cancelRequested", "settled", "refunded"][state]);
    const bumpOffset = state >= 2 ? 333 : 292;
    assert.equal(decoded.bump, f.records[2].data[bumpOffset]);
    assert.equal(decoded.escrowBump, f.records[2].data[bumpOffset + 1]);
    if (state >= 2) {
      assert.equal(decoded.acceptedReceipt.terminal, f.records[2].data[292]);
      assert.equal(BigInt(decoded.acceptedReceipt.filledQuantity.toString()), f.records[2].data.readBigUInt64LE(293));
      assert.equal(asHex(decoded.acceptedReceipt.receiptHash), f.expectedOutput.acceptedReceipt!.receiptHash);
    } else {
      assert.equal(decoded.acceptedReceipt, null);
    }
  }
});

for (const state of [0, 1, 2, 3] as const) {
  test(`observes ${["Pending", "CancelRequested", "Settled", "Refunded"][state]} with independent hashes and complete terms`, async () => {
    const f = fixture({ state });
    assert.equal(f.orderSerialized.length, state >= 2 ? 335 : 294);
    assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
    assert.equal(f.calls(), 1);
  });
}
for (const cancellation of [false, true]) {
  for (const balance of [0n, 1n, 9_999_999n, 10_000_000n, 10_000_001n, U64_MAX]) {
    test(`Settled permits cancellation=${cancellation} and terminal escrow=${balance}`, async () => {
      const f = fixture({ state: 2, cancellation, balance });
      assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
    });
  }
}
for (const balance of [0n, 1n, 9_999_999n, 10_000_000n, 10_000_001n, U64_MAX]) {
  test(`Refunded permits terminal escrow=${balance}`, async () => {
    const f = fixture({ state: 3, balance });
    assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
  });
}
for (const state of [0, 1] as const) {
  test(`active state ${state} permits donations and later permanent nonce`, async () => {
    const f = fixture({ state, donation: 123n, nextNonce: 98n });
    assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
  });
  test(`active state ${state} rejects an underfunded escrow`, async () => {
    await rejects(fixture({ state, balance: 9_999_999n }), "InvalidAmounts");
  });
}
for (const state of [0, 1, 3] as const) {
  test(`state ${state} permits unattainable positive minimum`, async () => {
    const f = fixture({ state, cash: 1n, minimum: U64_MAX });
    assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
  });
}
for (const state of [0, 1, 2, 3] as const) {
  test(`state ${state} preserves full-width uint64/uint256 and receipt endianness`, async () => {
    const f = fixture({ state, chainId: (1n << 256n) - 1n, nonce: U64_MAX - 1n,
      cash: U64_MAX / 2n, minimum: state === 2 ? U64_MAX - 1n : U64_MAX, balance: U64_MAX });
    assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
    if (state >= 2) {
      assert.equal(f.records[2].data.readBigUInt64LE(293), f.expectedOutput.acceptedReceipt!.filledQuantity);
    }
  });
}
for (const [label, options] of [
  ["Pending cancellation flag", { state: 0, cancellation: true }],
  ["CancelRequested cancellation flag", { state: 1, cancellation: false }],
  ["Refunded cancellation flag", { state: 3, cancellation: false }],
  ["Pending accepted receipt", { state: 0, receipt: true }],
  ["CancelRequested accepted receipt", { state: 1, receipt: true }],
  ["Settled missing receipt", { state: 2, receipt: false }],
  ["Refunded missing receipt", { state: 3, receipt: false }],
  ["Settled wrong terminal with matching hash", { state: 2, terminal: 2 }],
  ["Refunded wrong terminal with matching hash", { state: 3, terminal: 1 }],
  ["Settled Unseen terminal with matching hash", { state: 2, terminal: 0 }],
  ["Refunded unknown terminal with matching hash", { state: 3, terminal: 255 }],
  ["Settled zero quantity with matching hash", { state: 2, quantity: 0n }],
  ["Settled partial quantity with matching hash", { state: 2, quantity: 19_999_999n }],
  ["Settled excess quantity with matching hash", { state: 2, quantity: 20_000_001n }],
  ["Settled maximum quantity with matching hash", { state: 2, quantity: U64_MAX }],
  ["Refunded nonzero quantity with matching hash", { state: 3, quantity: 1n }],
  ["Refunded maximum quantity with matching hash", { state: 3, quantity: U64_MAX }],
  ["Settled unattainable minimum with matching terms/receipt hashes", { state: 2, cash: 1n, minimum: U64_MAX }],
] satisfies [string, FixtureOptions][]) {
  test(`rejects inconsistent ${label}`, async () => {
    await rejects(fixture(options), "InconsistentRecoveryRecord");
  });
}
// Some receipt fields: terminal=292, LE quantity=293..300, hash=301..332,
// order bump=333, escrow bump=334. None keeps bumps at 292/293.
for (const state of [2, 3] as const) {
  for (const [label, offset] of [["receipt hash", 301], ["receipt hash last byte", 332]] as const) {
    test(`terminal state ${state} rejects wrong ${label}`, async () => {
      const f = fixture({ state }); f.records[2].data[offset] ^= 1;
      await rejects(f, "InconsistentRecoveryRecord");
    });
  }
  for (const [label, offset, code] of [
    ["Order bump", 333, "InvalidBinding"], ["escrow bump", 334, "InvalidBinding"],
    ["identity", 129, "HashMismatch"], ["terms hash", 161, "HashMismatch"],
    ["stored cash ATA", 193, "InvalidBinding"], ["stored YES ATA", 225, "InvalidBinding"],
  ] satisfies [string, number, SourceOrderErrorCode][]) {
    test(`terminal state ${state} rejects wrong ${label}`, async () => {
      const f = fixture({ state }); f.records[2].data[offset] ^= 1; await rejects(f, code);
    });
  }
  for (const [label, offset, value] of [["enum", 289, 4], ["bool", 290, 2], ["Option", 291, 2]] as const) {
    test(`terminal state ${state} rejects malformed ${label}`, async () => {
      const f = fixture({ state }); f.records[2].data[offset] = value; await rejects(f, "InvalidAccount");
    });
  }
  test(`terminal state ${state} still validates escrow token state`, async () => {
    const f = fixture({ state }); f.records[3].data[108] = 2; await rejects(f, "InvalidBinding");
  });
}
test("zero nonce and allocated None padding preserve canonical bumps", async () => {
  const f = fixture({ nonce: 0n }); f.records[2].data.fill(0xff, 294);
  assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
});

for (const [index, name] of ["Config", "UserNonce", "Order", "Escrow"].entries()) {
  for (const [label, mutate, code] of [
    ["missing", (f: Fixture) => { f.response.value[index] = null; }, "MissingAccount"],
    ["wrong owner", (f: Fixture) => { f.records[index].owner = SystemProgram.programId; }, "InvalidAccount"],
    ["executable", (f: Fixture) => { f.records[index].executable = true; }, "InvalidAccount"],
    ["short allocation", (f: Fixture) => { f.records[index].data = f.records[index].data.subarray(0, -1); }, "InvalidAccount"],
    ["oversized allocation", (f: Fixture) => { f.records[index].data = Buffer.concat([f.records[index].data, Buffer.alloc(1)]); }, "InvalidAccount"],
    ...(index < 3 ? [["wrong discriminator", (f: Fixture) => { f.records[index].data[0] ^= 0xff; }, "InvalidAccount"] as const] : []),
  ] satisfies (readonly [string, (f: Fixture) => void, SourceOrderErrorCode])[]) {
    test(`${name} rejects ${label}`, async () => { const f = fixture(); mutate(f); await rejects(f, code); });
  }
}

for (const [label, mutate, code] of [
  ["changed Config byte", (f: Fixture) => { f.records[0].data[9] ^= 1; }, "ConfigurationMismatch"],
  ["wrong expected Config address", (f: Fixture) => { f.input.expectedConfiguration.solana.config.address = user.toBase58(); }, "ConfigurationMismatch"],
  ["wrong expected Config owner", (f: Fixture) => { f.input.expectedConfiguration.solana.config.owner = user.toBase58(); }, "ConfigurationMismatch"],
  ["wrong expected program identity", (f: Fixture) => { f.input.expectedConfiguration.solana.program.address = user.toBase58(); }, "ConfigurationMismatch"],
  ["short expected Config bytes", (f: Fixture) => { f.input.expectedConfiguration.solana.config.dataHex = "aa"; }, "ConfigurationMismatch"],
  ["malformed expected Config hex", (f: Fixture) => { f.input.expectedConfiguration.solana.config.dataHex = "zz".repeat(580); }, "ConfigurationMismatch"],
  ...[8, 104, 289, 482, 514, 546, 578].map((offset) => [
    `invalid pinned Config binding at offset ${offset} even with matching observation`, (f: Fixture) => {
      f.records[0].data[offset] ^= 1;
      f.input.expectedConfiguration.solana.config.dataHex = f.records[0].data.toString("hex");
    }, "ConfigurationMismatch",
  ] as const),
  ["wrong UserNonce Config", (f: Fixture) => { f.records[1].data[8] ^= 1; }, "InvalidBinding"],
  ["wrong UserNonce user", (f: Fixture) => { f.records[1].data[40] ^= 1; }, "InvalidBinding"],
  ["wrong UserNonce bump", (f: Fixture) => { f.records[1].data[80] ^= 1; }, "InvalidBinding"],
  ["next_nonce equal to order nonce", (f: Fixture) => { f.records[1].data.writeBigUInt64LE(7n, 72); }, "InvalidBinding"],
  ["next_nonce below order nonce", (f: Fixture) => { f.records[1].data.writeBigUInt64LE(6n, 72); }, "InvalidBinding"],
] satisfies (readonly [string, (f: Fixture) => void, SourceOrderErrorCode])[]) {
  test(`rejects ${label}`, async () => {
    const f = fixture(); mutate(f); await rejects(f, code);
    if (label.includes("expected")) assert.equal(f.calls(), 0, "Invalid trusted input fails before RPC");
  });
}

for (const field of ["config", "user", "nonce", "market", "outcome", "cashAta", "yesAta", "escrow", "bump", "escrowBump"] as const) {
  test(`rejects wrong stored Order ${field}`, async () => {
    const f = fixture();
    f.records[2].data[orderOffsets[field]] ^= 1;
    await rejects(f, "InvalidBinding");
  });
}
for (const field of ["id", "hash"] as const) {
  test(`rejects wrong canonical Order ${field}`, async () => {
    const f = fixture(); f.records[2].data[orderOffsets[field]] ^= 1; await rejects(f, "HashMismatch");
  });
}
for (const [label, offset, value] of [["state", 289, 4], ["bool", 290, 2], ["Option", 291, 2]] as const) {
  test(`rejects malformed Borsh ${label} tag`, async () => {
    const f = fixture(); f.records[2].data[offset] = value; await rejects(f, "InvalidAccount");
  });
}
for (const [label, offset, amount] of [["zero cash", 113, 0n], ["cash above full-fill bound", 113, U64_MAX / 2n + 1n], ["zero minimum", 121, 0n]] as const) {
  test(`rejects ${label}`, async () => {
    const f = fixture(); f.records[2].data.writeBigUInt64LE(amount, offset); await rejects(f, "InvalidAmounts");
  });
}

for (const [label, mutate, code] of [
  ["wrong token authority", (data: Buffer) => { data[32] ^= 1; }, "InvalidBinding"],
  ["wrong mint", (data: Buffer) => { data[0] ^= 1; }, "InvalidBinding"],
  ["uninitialized state", (data: Buffer) => { data[108] = 0; }, "InvalidBinding"],
  ["frozen state", (data: Buffer) => { data[108] = 2; }, "InvalidBinding"],
  ["unknown state", (data: Buffer) => { data[108] = 3; }, "InvalidBinding"],
  ["delegate", (data: Buffer) => { data.writeUInt32LE(1, 72); user.toBuffer().copy(data, 76); }, "InvalidBinding"],
  ["nonzero delegated amount", (data: Buffer) => { data.writeBigUInt64LE(1n, 121); }, "InvalidBinding"],
  ["close authority", (data: Buffer) => { data.writeUInt32LE(1, 129); user.toBuffer().copy(data, 133); }, "InvalidBinding"],
  ["native-token state", (data: Buffer) => { data.writeUInt32LE(1, 109); data.writeBigUInt64LE(1n, 113); }, "InvalidBinding"],
  ["malformed delegate Option", (data: Buffer) => { data.writeUInt32LE(2, 72); }, "InvalidBinding"],
  ["malformed native Option", (data: Buffer) => { data.writeUInt32LE(2, 109); }, "InvalidBinding"],
  ["malformed close Option", (data: Buffer) => { data.writeUInt32LE(2, 129); }, "InvalidBinding"],
  ["insufficient cash", (data: Buffer) => { data.writeBigUInt64LE(9_999_999n, 64); }, "InvalidAmounts"],
] satisfies [string, (data: Buffer) => void, SourceOrderErrorCode][]) {
  test(`Escrow rejects ${label}`, async () => { const f = fixture(); mutate(f.records[3].data); await rejects(f, code); });
}
test("Escrow rejects Token-2022 ownership", async () => {
  const f = fixture(); f.records[3].owner = TOKEN_2022_PROGRAM_ID; await rejects(f, "InvalidAccount");
});

for (const nonce of [-1n, U64_MAX, U64_MAX + 1n, 7, "7", null, undefined]) {
  test(`rejects invalid input nonce ${String(nonce)} (${typeof nonce}) before RPC`, async () => {
    const f = fixture(); await rejects({ ...f, input: { ...f.input, nonce } as unknown as ReadFinalizedRecoveryOrderInput }, "InvalidInput");
    assert.equal(f.calls(), 0);
  });
}
for (const slot of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "110"]) {
  test(`rejects invalid minimum slot ${String(slot)} (${typeof slot}) before RPC`, async () => {
    const f = fixture(); await rejects({ ...f, input: { ...f.input, minFinalizedSlot: slot } as unknown as ReadFinalizedRecoveryOrderInput }, "InvalidInput");
    assert.equal(f.calls(), 0);
  });
}
test("rejects zero user before RPC", async () => {
  const f = fixture(); await rejects({ ...f, input: { ...f.input, user: PublicKey.default } }, "InvalidInput"); assert.equal(f.calls(), 0);
});
for (const invalidUser of [null, undefined, user.toBase58(), user.toBytes()]) {
  test(`rejects non-PublicKey user (${typeof invalidUser}) before RPC`, async () => {
    const f = fixture();
    await rejects({ ...f, input: { ...f.input, user: invalidUser } as unknown as ReadFinalizedRecoveryOrderInput }, "InvalidInput");
    assert.equal(f.calls(), 0);
  });
}
for (const role of ["operator", "executor"] as const) {
  test(`rejects user bound to reserved ${role} in observed Config`, async () => {
    const f = fixture();
    // Make the observed source role equal the original user while keeping exact
    // expected bytes, exercising reserved-role validation rather than hash drift.
    user.toBuffer().copy(f.records[0].data, role === "operator" ? 290 : 322);
    f.input.expectedConfiguration.solana.config.dataHex = f.records[0].data.toString("hex");
    await rejects(f, "InvalidInput");
  });
}
for (const slot of [109, 0, -1, 123.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
  test(`rejects stale or invalid returned context slot ${String(slot)}`, async () => {
    const f = fixture(); f.response.context.slot = slot; await rejects(f, "StaleContext");
  });
}
test("accepts a finalized context exactly at the supplied minimum slot", async () => {
  const f = fixture(); f.response.context.slot = 110;
  assert.deepEqual(await readFinalizedRecoveryOrder(f.input), { ...f.expectedOutput, contextSlot: 110 });
});
test("rejects truncated RPC account vector", async () => {
  const f = fixture(); f.response.value.pop(); await rejects(f, "InvalidAccount");
});
test("RPC failure propagates unchanged without retries", async () => {
  const f = fixture(); const failure = new Error("controlled RPC failure"); let calls = 0;
  const connection: SourceOrderConnection = { async getMultipleAccountsInfoAndContext() { calls += 1; throw failure; } };
  await assert.rejects(readFinalizedRecoveryOrder({ ...f.input, connection }), (error) => error === failure);
  assert.equal(calls, 1);
});
for (const rejectsRpc of [false, true]) {
  test(`RPC ${rejectsRpc ? "rejection" : "success"} clears the exact deadline timer`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const scheduled = context.mock.method(globalThis, "setTimeout");
    const clear = context.mock.method(globalThis, "clearTimeout");
    const f = fixture();
    const failure = new Error("controlled asynchronous RPC rejection");
    const connection: SourceOrderConnection = {
      getMultipleAccountsInfoAndContext: () => Promise.reject(failure),
    };
    if (rejectsRpc) {
      await assert.rejects(readFinalizedRecoveryOrder({ ...f.input, connection }), (error) => error === failure);
    } else {
      assert.deepEqual(await readFinalizedRecoveryOrder(f.input), f.expectedOutput);
    }
    assert.equal(scheduled.mock.callCount(), 1);
    assert.equal(scheduled.mock.calls[0].arguments[1], 10_000);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(clear.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
    context.mock.timers.tick(10_000);
    assert.equal(clear.mock.callCount(), 1);
  });
}
test("unresponsive RPC fails at the bounded deadline and clears its timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = context.mock.method(globalThis, "setTimeout");
  const clear = context.mock.method(globalThis, "clearTimeout");
  const f = fixture();
  const connection: SourceOrderConnection = { getMultipleAccountsInfoAndContext: () => new Promise(() => {}) };
  const assertion = rejects({ ...f, input: { ...f.input, connection } }, "RpcTimeout");
  context.mock.timers.tick(9_999);
  assert.equal(clear.mock.callCount(), 0);
  context.mock.timers.tick(1);
  await assertion;
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
});
test("success and rejection preserve caller inputs, RPC records and independent returned objects", async () => {
  const firstFixture = fixture({ state: 2 }); const secondFixture = fixture({ state: 2 });
  const before = structuredClone(firstFixture.input.expectedConfiguration);
  const beforeRecords = firstFixture.records.map((record) => ({ ...record, data: Buffer.from(record.data), owner: record.owner.toBase58() }));
  const userBefore = firstFixture.input.user.toBytes();
  const first = await readFinalizedRecoveryOrder(firstFixture.input);
  const second = await readFinalizedRecoveryOrder(secondFixture.input);
  assert.notEqual(first.accounts, second.accounts);
  assert.notEqual(first.terms, second.terms);
  assert.notEqual(first.terms.identity, second.terms.identity);
  assert.notEqual(first.terms.identity.domain, second.terms.identity.domain);
  assert.notEqual(first.acceptedReceipt, second.acceptedReceipt);
  assert.ok(first.acceptedReceipt);
  first.acceptedReceipt.filledQuantity = 1n;
  first.terms.cashAmount = 1n;
  first.terms.identity.domain.chainId = 1n;
  first.accounts.order = "changed";
  assert.deepEqual(second, secondFixture.expectedOutput);
  assert.deepEqual(firstFixture.input.expectedConfiguration, before);
  assert.deepEqual(firstFixture.input.user.toBytes(), userBefore);
  assert.deepEqual(firstFixture.records.map((record) => ({ ...record, owner: record.owner.toBase58() })), beforeRecords);
  for (const state of [0, 2, 3] as const) {
    const rejected = fixture({ state, cancellation: true });
    if (state >= 2) rejected.records[2].data[301] ^= 1;
    const rejectedBefore = structuredClone(rejected.input.expectedConfiguration);
    const rejectedRecords = rejected.records.map((record) => ({ ...record, data: Buffer.from(record.data), owner: record.owner.toBase58() }));
    await rejects(rejected, "InconsistentRecoveryRecord");
    assert.deepEqual(rejected.input.expectedConfiguration, rejectedBefore);
    assert.deepEqual(rejected.records.map((record) => ({ ...record, owner: record.owner.toBase58() })), rejectedRecords);
  }
});
test("trusted inputs are snapshotted before awaiting the controlled read", async () => {
  const f = fixture();
  let resolveRead!: (value: Fixture["response"]) => void;
  const connection: SourceOrderConnection = { getMultipleAccountsInfoAndContext: () => new Promise((resolve) => { resolveRead = resolve; }) };
  const input = { ...f.input, connection };
  const observation = readFinalizedRecoveryOrder(input);
  Object.assign(input, { user: publicKey(0x56), nonce: 99n, minFinalizedSlot: 999 });
  f.input.expectedConfiguration.solana.config.dataHex = "ff".repeat(580);
  resolveRead(f.response);
  assert.deepEqual(await observation, f.expectedOutput);
});
