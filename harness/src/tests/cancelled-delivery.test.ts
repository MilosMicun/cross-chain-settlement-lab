import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";
import type { EvmTerms, FinalizedCancellationRequest } from "../source-order.ts";
import type { TerminalObservationResult } from "../terminal-observation.ts";
import type { BuildAcceptCancelledInstructionInput } from "../cancelled-delivery.ts";
const { buildAcceptCancelledInstruction } = await import(new URL("../cancelled-delivery.ts", import.meta.url).href) as typeof import("../cancelled-delivery.ts");
const { AnchorProvider, BN, BorshInstructionCoder, Program } = anchor;
const actualIdl = JSON.parse(readFileSync(new URL("../../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as SettlementLab;

// Public synthetic evidence only. Independent manual Config/Borsh layouts and
// SPEC SHA-256 preimages; no existing test suite or protocol encoder is imported.
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
function fixture(options: { nonce?: bigint; cash?: bigint; minimum?: bigint; donation?: bigint } = {}) {
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
  const balance = cash + (options.donation ?? 0n);
  const sourceRequest = { accounts: { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
    userCashAta: cashAta.toBase58(), userYesAta: yesAta.toBase58() }, contextSlot: 123, state: "CancelRequested", cancellationRequested: true, orderId: asHex(orderId), termsHash: asHex(termsHash), escrowBalance: balance,
  terms: { identity: { domain: { sourceDomain: shared.sourceDomain, destinationDomain: shared.destinationDomain, solanaProgram: shared.solanaProgram,
    chainId: 31337n, settlement: shared.settlement }, user: "0x" + "55".repeat(32), nonce }, market: shared.market, outcome: 0, cashAmount: cash, minimumShares: minimum } };
  const source = sourceRequest as FinalizedCancellationRequest;
  const receipt = { termsHash: source.termsHash, terminal: 2 as const, filledQuantity: 0n };
  const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), termsHash, Buffer.from([2]), uint(0n, 8)]);
  assert.equal(receiptPreimage.length, 49);
  const observation: Extract<TerminalObservationResult, { kind: "Confirmed" }> = {
    kind: "Confirmed", orderId: source.orderId, termsHash: source.termsHash, terms: structuredClone(source.terms),
    receipt, receiptHash: asHex(hash(receiptPreimage)) as typeof source.termsHash,
    transactionHash: ("0x" + "aa".repeat(32)) as typeof source.termsHash,
    inclusion: { number: 10n, hash: ("0x" + "bb".repeat(32)) as typeof source.termsHash },
    observationHead: { number: 12n, hash: ("0x" + "cc".repeat(32)) as typeof source.termsHash }, additionalBlocks: 2n,
  };
  let ioCalls = 0;
  const rejectIO = async () => { ioCalls++; throw new Error("Forbidden instruction-builder I/O"); };
  const connection = new Proxy(new Connection("http://127.0.0.1:18899", { commitment: "finalized", fetch: rejectIO }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? rejectIO : value;
    },
  });
  const wallet = { publicKey: operator, signTransaction: rejectIO, signAllTransactions: rejectIO };
  const provider = new Proxy(new AnchorProvider(connection, wallet, { commitment: "finalized" }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? rejectIO : value;
    },
  });
  const client = new Program<SettlementLab>(structuredClone(actualIdl), provider);
  const input: BuildAcceptCancelledInstructionInput = { program: client, expectedConfiguration, sourceRequest: source, observation };
  const expectedArgs = { terms: { domain: { sourceDomain: [...raw(shared.sourceDomain)], destinationDomain: [...raw(shared.destinationDomain)],
    solanaProgram: program, chainId: [...uint(31337n, 32)], settlement: [...raw(shared.settlement)] },
    user, nonce: new BN(nonce.toString()), market: [...raw(shared.market)], outcome: 0,
    cashAmount: new BN(cash.toString()), minimumShares: new BN(minimum.toString()) },
    receipt: { termsHash: [...termsHash], terminal: 2, filledQuantity: new BN("0") } };
  const instructionBytes = Buffer.concat([hash(Buffer.from("global:accept_cancelled")).subarray(0, 8), domain,
    user.toBuffer(), uint(nonce, 8, "le"), raw(shared.market), Buffer.from([0]), uint(cash, 8, "le"), uint(minimum, 8, "le"),
    termsHash, Buffer.from([2]), uint(0n, 8, "le")]);
  const accountKeys = [operator, user, config, accounting, userNonce, order, cashMint, cashAta, escrow, TOKEN_PROGRAM_ID];
  return { input, observation, expectedArgs, instructionBytes, accountKeys, ioCalls: () => ioCalls };
}
type Fixture = ReturnType<typeof fixture>;
function normalize(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}
function evidence(f: Fixture) {
  return structuredClone({ expectedConfiguration: f.input.expectedConfiguration, sourceRequest: f.input.sourceRequest, observation: f.input.observation });
}
async function verifyInstruction(f: Fixture) {
  const before = evidence(f);
  const ix = await buildAcceptCancelledInstruction(f.input);
  assert.deepEqual(evidence(f), before, "Caller evidence is preserved");
  assert.ok(ix.programId.equals(program));
  assert.equal(ix.data.length, 286);
  assert.equal(ix.data.subarray(0, 8).toString("hex"), "40035adf88c1e3bb");
  assert.deepEqual(ix.data, f.instructionBytes, "Independent discriminator and manual Borsh field order/widths");
  const coder = f.input.program.coder.instruction;
  assert.ok(coder instanceof BorshInstructionCoder);
  const decoded = coder.decode(ix.data);
  assert.ok(decoded);
  assert.equal(decoded.name, "acceptCancelled");
  assert.deepEqual(normalize(decoded.data), normalize({ args: f.expectedArgs }));
  assert.deepEqual(ix.keys, f.accountKeys.map((pubkey, index) => ({ pubkey, isSigner: index === 0,
    isWritable: [3, 5, 7, 8].includes(index) })));
  const idlInstruction = f.input.program.idl.instructions.find((i) => i.name === "acceptCancelled");
  assert.ok(idlInstruction);
  assert.deepEqual(idlInstruction.accounts.map((a) => a.name),
    ["operator", "user", "config", "accounting", "userNonce", "order", "cashMint", "userCashAta", "escrow", "tokenProgram"]);
  assert.deepEqual(ix.keys.map((a) => [a.isSigner, a.isWritable]), idlInstruction.accounts.map((a) => ["signer" in a && a.signer === true, "writable" in a && a.writable === true]));
  assert.equal(f.ioCalls(), 0);
  return ix;
}
function setPath(object: unknown, path: string, value: unknown) {
  const keys = path.split(".");
  let record = object as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) record = record[key] as Record<string, unknown>;
  record[keys.at(-1)!] = value;
}
function patchConfig(f: Fixture, offset: number, bytes: Uint8Array) {
  const c = f.input.expectedConfiguration.solana.config;
  const data = Buffer.from(c.dataHex, "hex"); data.set(bytes, offset); c.dataHex = data.toString("hex");
}
// Independently rebind synthetic evidence so semantic/binding failures cannot
// hide behind an earlier stale hash failure.
function rehash(f: Fixture) {
  const source = f.input.sourceRequest, t = source.terms, d = t.identity.domain;
  const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
  const id = hash(Buffer.concat([Buffer.from("CCSLID01"), domain, raw(t.identity.user), uint(t.identity.nonce, 8)]));
  const th = hash(Buffer.concat([Buffer.from("CCSLTR01"), domain, id, raw(t.identity.user), uint(t.identity.nonce, 8), raw(t.market),
    Buffer.from([t.outcome]), uint(t.cashAmount, 8), uint(t.minimumShares, 8)]));
  source.orderId = asHex(id) as typeof source.orderId; source.termsHash = asHex(th) as typeof source.termsHash;
  f.observation.terms = structuredClone(t); f.observation.orderId = source.orderId; f.observation.termsHash = source.termsHash;
  f.observation.receipt.termsHash = source.termsHash;
  f.observation.receiptHash = asHex(hash(Buffer.concat([Buffer.from("CCSLRC01"), th, Buffer.from([2]), uint(0n, 8)]))) as typeof source.termsHash;
}
async function rejects(f: Fixture, pattern?: RegExp) {
  const before = evidence(f);
  await assert.rejects(buildAcceptCancelledInstruction(f.input), pattern ?? ((error: unknown) => error instanceof Error));
  assert.deepEqual(evidence(f), before, "Failure preserves caller evidence");
  assert.equal(f.ioCalls(), 0, "Neither validation nor construction attempts RPC/signing/submission");
}

test("Confirmed/Cancelled encodes the actual generated instruction and all ten account metas", async () => {
  await verifyInstruction(fixture());
});
for (const [label, options] of [
  ["lowest protocol amounts and nonce", { nonce: 0n, cash: 1n, minimum: 1n }],
  ["unattainable positive minimum", { cash: 1n, minimum: U64_MAX }],
  ["maximum protocol amounts and nonce retain bigint precision", { nonce: U64_MAX - 1n, cash: U64_MAX / 2n, minimum: U64_MAX }],
  ["nontrivial high nonce exposes big-endian PDA versus little-endian Borsh", { nonce: 0x0102030405060708n }],
  ["maximum valid escrow with an unsolicited donation", { donation: U64_MAX - 10_000_000n }],
] as const) test(label, async () => { await verifyInstruction(fixture(options)); });

test("explicit replay construction is deterministic with independent mutable output buffers", async () => {
  const f = fixture(), before = evidence(f);
  const first = await buildAcceptCancelledInstruction(f.input), replay = await buildAcceptCancelledInstruction(f.input);
  assert.deepEqual(first, replay);
  assert.notStrictEqual(first.data, replay.data); assert.notStrictEqual(first.keys, replay.keys);
  first.data.fill(0); first.keys[0].isSigner = false; first.keys[0].pubkey = PublicKey.default;
  assert.deepEqual(replay.data, f.instructionBytes); assert.ok(replay.keys[0].isSigner);
  assert.ok(replay.keys[0].pubkey.equals(operator));
  assert.deepEqual(evidence(f), before); assert.equal(f.ioCalls(), 0);
});

test("caller evidence is snapshotted before instruction construction yields and Program is retained", async () => {
  const f = fixture();
  const client = f.input.program;
  const original = client.methods.acceptCancelled;
  let resolveConstruction: (() => void) | undefined;
  let entered = 0;
  const gate = new Promise<void>((resolve) => { resolveConstruction = resolve; });
  client.methods.acceptCancelled = (args) => {
    entered++;
    const builder = original(args), originalInstruction = builder.instruction.bind(builder);
    builder.instruction = async () => { await gate; return originalInstruction(); };
    return builder;
  };
  const building = buildAcceptCancelledInstruction(f.input);
  assert.equal(entered, 1, "The supplied Program instance constructs the instruction");
  f.input.sourceRequest.terms.cashAmount = 1n;
  f.input.sourceRequest.accounts.userCashAta = PublicKey.default.toBase58();
  f.observation.receipt.filledQuantity = 17n;
  f.input.expectedConfiguration.solana.config.operator = PublicKey.default.toBase58();
  resolveConstruction!();
  const result = await building;
  assert.deepEqual(result.data, f.instructionBytes);
  assert.deepEqual(result.keys.map((a) => a.pubkey.toBase58()), f.accountKeys.map((k) => k.toBase58()));
  assert.equal(f.input.sourceRequest.terms.cashAmount, 1n);
  assert.equal(f.observation.receipt.filledQuantity, 17n); assert.equal(f.ioCalls(), 0);
});

const changedHash = "0x" + "fe".repeat(32);
const zero32 = "0x" + "00".repeat(32);
const invalidEvidence: [string, unknown][] = [
  ["observation", { kind: "NotConfirmed", reason: "MissingReceipt" }],
  ["observation.receipt.terminal", 1], ["observation.receipt.terminal", 0],
  ...["Pending", "Settled", "Refunded"].map((v): [string, unknown] => ["sourceRequest.state", v]),
  ["sourceRequest.cancellationRequested", false], ["sourceRequest.cancellationRequested", 1],
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123"].map((v): [string, unknown] => ["sourceRequest.contextSlot", v]),
  ...[0n, -1n, 9_999_999n, U64_MAX + 1n, 10_000_000].map((v): [string, unknown] => ["sourceRequest.escrowBalance", v]),
  ...[1n, -1n, U64_MAX, 0, "0"].map((v): [string, unknown] => ["observation.receipt.filledQuantity", v]),
  ...["sourceRequest.orderId", "observation.orderId", "sourceRequest.termsHash", "observation.termsHash",
    "observation.receipt.termsHash", "observation.receiptHash"].flatMap((path): [string, unknown][] => [[path, changedHash], [path, "0x11"]]),
  ...["observation.terms.identity.domain.sourceDomain", "observation.terms.identity.domain.destinationDomain",
    "observation.terms.identity.domain.solanaProgram", "observation.terms.identity.user", "observation.terms.market"].map((path): [string, unknown] => [path, changedHash]),
  ["observation.terms.identity.domain.settlement", "0x" + "fe".repeat(20)],
  ["observation.terms.identity.domain.chainId", 1n], ["observation.terms.identity.nonce", 8n],
  ["observation.terms.outcome", 1], ["observation.terms.cashAmount", 11_000_000n], ["observation.terms.minimumShares", 1n],
  ...[-1n, U64_MAX, U64_MAX + 1n, 7].map((v): [string, unknown] => ["sourceRequest.terms.identity.nonce", v]),
  ...[0n, -1n, U64_MAX / 2n + 1n, U64_MAX + 1n, 10_000_000].map((v): [string, unknown] => ["sourceRequest.terms.cashAmount", v]),
  ...[0n, -1n, U64_MAX + 1n, 20_000_000].map((v): [string, unknown] => ["sourceRequest.terms.minimumShares", v]),
  ["sourceRequest.terms.outcome", 1],
  ...["sourceRequest.terms.identity.domain.sourceDomain", "sourceRequest.terms.identity.domain.destinationDomain",
    "sourceRequest.terms.identity.domain.solanaProgram", "sourceRequest.terms.identity.user", "sourceRequest.terms.market"].map((path): [string, unknown] => [path, "0x11"]),
];
for (const [index, [path, value]] of invalidEvidence.entries()) test(`reject evidence ${index + 1}: ${path} = ${String(value)}`, async () => {
  const f = fixture(); setPath(f.input, path, value); await rejects(f);
});

const invalidConfirmation: [string, unknown][] = [
  ...["transactionHash", "inclusion.hash", "observationHead.hash"].flatMap((path): [string, unknown][] =>
    [[path, zero32], [path, "0x11"], [path, "0x" + "gg".repeat(32)], [path, "0x" + "11".repeat(33)]]),
  ...["inclusion.number", "observationHead.number"].flatMap((path): [string, unknown][] =>
    [[path, -1n], [path, 1n << 256n], [path, 10], [path, "10"]]),
  ...[-1n, 0n, 1n, 3n, 2, "2"].map((v): [string, unknown] => ["additionalBlocks", v]),
  ["observationHead.number", 9n], ["observationHead.number", 13n], ["observationHead.hash", "0x" + "bb".repeat(32)],
];
for (const [index, [path, value]] of invalidConfirmation.entries()) test(`reject confirmation ${index + 1}: ${path} = ${String(value)}`, async () => {
  const f = fixture(); setPath(f.observation, path, value); await rejects(f);
});

test("confirmation metadata retains the valid uint256 block-number range", async () => {
  const f = fixture(); f.observation.inclusion.number = (1n << 256n) - 3n;
  f.observation.observationHead.number = (1n << 256n) - 1n;
  await verifyInstruction(f);
});
const invalidConfiguration: [string, unknown][] = [
  ["solana.commitment", "confirmed"], ["solana.contextSlot", 0], ["solana.contextSlot", 89],
  ["solana.minContextSlot", 0], ["solana.minContextSlot", 124], ["solana.contextSlot", Number.MAX_SAFE_INTEGER + 1],
  ["solana.program.address", user.toBase58()], ["solana.program.executable", false], ["solana.program.upgradeAuthority", operator.toBase58()],
  ["solana.config.address", user.toBase58()], ["solana.config.owner", user.toBase58()], ["solana.config.version", 2],
  ["solana.config.outcome", 1], ["solana.config.bump", -1], ["solana.config.yesAuthorityBump", -1],
  ["solana.config.yesAuthority", user.toBase58()],
  ...["address", "owner", "config"].map((field): [string, unknown] => [`solana.accounting.${field}`, user.toBase58()]),
  ["solana.accounting.bump", -1], ["evm.rpcChainId", "1"],
  ...["sourceDomain", "destinationDomain", "solanaProgram", "market"].map((field): [string, unknown] => [`solana.configuration.${field}`, changedHash]),
  ...["settlement", "venue", "cashToken", "yesToken", "evmOperator", "evmExecutor"].map((field): [string, unknown] =>
    [`evm.configuration.${field}`, "0x" + "fe".repeat(20)]),
  ["solana.configuration.chainId", "1"],
  ...["operator", "executor", "cashMint", "yesMint", "executorCashAta", "tokenProgram", "associatedTokenProgram", "systemProgram"].map((field): [string, unknown] =>
    [`solana.config.${field}`, user.toBase58()]),
  ["solana.config.dataHex", "00"], ["solana.config.dataHex", "gg".repeat(580)],
];
for (const [index, [path, value]] of invalidConfiguration.entries()) test(`reject configuration ${index + 1}: ${path}`, async () => {
  const f = fixture(); setPath(f.input.expectedConfiguration, path, value); await rejects(f);
});

for (const [name, offset] of Object.entries({ discriminator: 0, version: 8, sourceDomain: 9, destinationDomain: 41,
  solanaProgram: 73, chainId: 105, settlement: 137, venue: 157, cashToken: 177, yesToken: 197,
  evmOperator: 217, evmExecutor: 237, market: 257, outcome: 289, operator: 290, executor: 322,
  cashMint: 354, yesMint: 386, executorCashAta: 418, yesAuthority: 450, tokenProgram: 482,
  associatedTokenProgram: 514, systemProgram: 546, bump: 578, yesAuthorityBump: 579 })) {
  test(`reject independent Config bytes conflicting at ${name}`, async () => {
    const f = fixture(), data = Buffer.from(f.input.expectedConfiguration.solana.config.dataHex, "hex");
    data[offset] ^= 1; f.input.expectedConfiguration.solana.config.dataHex = data.toString("hex"); await rejects(f);
  });
}
for (const name of ["config", "userNonce", "order", "escrow", "userCashAta", "userYesAta"] as const) {
  test(`reject substituted source ${name}`, async () => {
    const f = fixture(); f.input.sourceRequest.accounts[name] = operator.toBase58(); await rejects(f, new RegExp(`source ${name}`));
  });
}
test("reject little-endian nonce Order seeds despite correct hashes", async () => {
  const f = fixture({ nonce: 0x0102030405060708n });
  const config = f.accountKeys[2];
  const [wrongOrder] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(),
    uint(f.input.sourceRequest.terms.identity.nonce, 8, "le")], program);
  f.input.sourceRequest.accounts.order = wrongOrder.toBase58(); await rejects(f, /source order/);
});
test("reject Program.programId independently of correct IDL", async () => {
  const f = fixture(); Object.defineProperty(f.input.program, "programId", { value: user }); await rejects(f, /program\/IDL/);
});
test("reject IDL address independently of correct Program.programId", async () => {
  const f = fixture(); setPath(f.input.program.idl, "address", user.toBase58()); await rejects(f, /program\/IDL/);
});
test("reject coherently rehashed terms selecting a different repository program", async () => {
  const f = fixture(); f.input.sourceRequest.terms.identity.domain.solanaProgram = changedHash as EvmTerms["identity"]["domain"]["solanaProgram"];
  rehash(f); await rejects(f, /program\/IDL/);
});

for (const [field, offset, value] of [
  ["sourceDomain", 9, zero32], ["destinationDomain", 41, zero32],
  ["destinationDomain", 41, shared.sourceDomain], ["market", 257, zero32],
  ["settlement", 137, "0x" + "00".repeat(20)], ["venue", 157, "0x" + "00".repeat(20)],
  ["cashToken", 177, "0x" + "00".repeat(20)], ["yesToken", 197, "0x" + "00".repeat(20)],
  ["evmOperator", 217, "0x" + "00".repeat(20)], ["evmExecutor", 237, "0x" + "00".repeat(20)],
  ["yesToken", 197, shared.cashToken], ["evmExecutor", 237, shared.evmOperator],
] as const) test(`reject coherently configured ${field} = ${value}`, async () => {
  const f = fixture();
  setPath(f.input.expectedConfiguration.solana.configuration, field, value);
  setPath(f.input.expectedConfiguration.evm.configuration, field, value);
  patchConfig(f, offset, raw(value));
  if (field === "market") setPath(f.input.sourceRequest.terms, field, value);
  else if (["sourceDomain", "destinationDomain", "settlement"].includes(field)) setPath(f.input.sourceRequest.terms.identity.domain, field, value);
  rehash(f); await rejects(f, /nonzero|distinct/);
});
test("reject coherently configured wrong chain ID", async () => {
  const f = fixture(); f.input.sourceRequest.terms.identity.domain.chainId = 1n;
  f.input.expectedConfiguration.solana.configuration.chainId = "1"; f.input.expectedConfiguration.evm.configuration.chainId = "1";
  patchConfig(f, 105, uint(1n, 32)); rehash(f); await rejects(f, /shared configuration\/chain/);
});
for (const [field, offset, key] of [
  ["operator", 290, PublicKey.default], ["executor", 322, PublicKey.default],
  ["operator", 290, user], ["executor", 322, user], ["executor", 322, operator],
  ["yesMint", 386, cashMint],
] as const) test(`reject coherent source roles/mints ${field} = ${key.toBase58()}`, async () => {
  const f = fixture(); setPath(f.input.expectedConfiguration.solana.config, field, key.toBase58());
  patchConfig(f, offset, key.toBytes()); await rejects(f, /roles\/mints/);
});
for (const key of [user, publicKey(0xa1)]) test(`reject coherent noncanonical executor cash ATA ${key.toBase58()}`, async () => {
  const f = fixture(); f.input.expectedConfiguration.solana.config.executorCashAta = key.toBase58();
  patchConfig(f, 418, key.toBytes()); await rejects(f, /executor ATA/);
});
for (const [label, key] of [["zero user", PublicKey.default], ["user is operator", operator], ["user is executor", executor]] as const) {
  test(`reject coherently rehashed ${label}`, async () => {
    const f = fixture(); f.input.sourceRequest.terms.identity.user = asHex(key.toBytes()) as EvmTerms["identity"]["user"];
    rehash(f); await rejects(f, /roles\/mints/);
  });
}
test("reject instruction account alias even with coherent Config bytes and canonical source addresses", async () => {
  const f = fixture(), c = f.input.expectedConfiguration.solana.config;
  const aliasedMint = f.accountKeys[2]; // cashMint aliases Config.
  c.cashMint = aliasedMint.toBase58(); patchConfig(f, 354, aliasedMint.toBytes());
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(aliasedMint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  c.executorCashAta = ata(executor).toBase58(); patchConfig(f, 418, ata(executor).toBytes());
  f.input.sourceRequest.accounts.userCashAta = ata(user).toBase58();
  await rejects(f, /unsafe account alias/);
});
