import { isDeepStrictEqual } from "node:util";
import anchor, { type Program } from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import type { SettlementLab } from "../../solana/target/types/settlement_lab.ts";
import type { LiveConfigurationObservation } from "./live-configuration.ts";
import type { FinalizedCancellationRequest, EvmTerms } from "./source-order.ts";
import type { TerminalObservationResult } from "./terminal-observation.ts";
import type { Terms } from "./protocol-encoding.ts";
const { orderId, termsHash, receiptHash } = await import(new URL("./protocol-encoding.ts", import.meta.url).href) as typeof import("./protocol-encoding.ts");
const { BN } = anchor;

export type BuildAcceptCancelledInstructionInput = {
  readonly program: Program<SettlementLab>;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly sourceRequest: FinalizedCancellationRequest;
  readonly observation: TerminalObservationResult;
};
function requireInput(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid Cancelled delivery: ${message}`);
}
function raw(value: unknown, width: number): Buffer {
  requireInput(typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${width * 2}}$`).test(value), `expected ${width}-byte hex`);
  return Buffer.from(value.slice(2), "hex");
}
function canonical(t: EvmTerms): Terms {
  const d = t.identity.domain;
  return { identity: { domain: { sourceDomain: raw(d.sourceDomain, 32), destinationDomain: raw(d.destinationDomain, 32),
    solanaProgram: raw(d.solanaProgram, 32), chainId: d.chainId, settlement: raw(d.settlement, 20) },
  user: raw(t.identity.user, 32), nonce: t.identity.nonce }, market: raw(t.market, 32), outcome: t.outcome,
  cashAmount: t.cashAmount, minimumShares: t.minimumShares };
}
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const sameHex = (value: unknown, expected: Buffer) => raw(value, expected.length).equals(expected);
const safeSlot = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Converts trusted observations into an operator-attested instruction only.
 * A fabricated Confirmed object is not a cryptographic EVM proof; a source
 * cancellation request alone does not authorize refund. Snapshots are not locks.
 * Permanent on-chain records resolve races, conflicts and exact replay; the
 * original valid snapshot can construct an explicit replay without RPC checks.
 * Building an instruction does not prove a completed refund. No I/O or signing.
 */
export async function buildAcceptCancelledInstruction(input: BuildAcceptCancelledInstructionInput): Promise<TransactionInstruction> {
  const { program } = input;
  // Own all input values before instruction() yields; retain no mutable evidence.
  const { expectedConfiguration: cfg, sourceRequest: source, observation: observed } = structuredClone({
    expectedConfiguration: input.expectedConfiguration, sourceRequest: input.sourceRequest, observation: input.observation,
  });
  requireInput(observed?.kind === "Confirmed" && observed.receipt?.terminal === 2, "requires Confirmed/Cancelled");
  const t = canonical(source.terms), ot = canonical(observed.terms), d = t.identity.domain;
  const id = orderId(t.identity), hash = termsHash(t);
  const max = (1n << 64n) - 1n;
  requireInput(source.state === "CancelRequested" && source.cancellationRequested === true && safeSlot(source.contextSlot)
    && typeof source.escrowBalance === "bigint" && source.escrowBalance >= t.cashAmount && source.escrowBalance <= max,
  "expected finalized CancelRequested source snapshot");
  requireInput(typeof t.identity.nonce === "bigint" && t.identity.nonce >= 0n && t.identity.nonce < max
    && t.outcome === 0 && typeof t.cashAmount === "bigint" && t.cashAmount >= 1n && t.cashAmount <= max / 2n
    && typeof t.minimumShares === "bigint" && t.minimumShares >= 1n && t.minimumShares <= max,
  "nonce, YES outcome or amount bounds");
  requireInput(isDeepStrictEqual(t, ot) && sameHex(source.orderId, id) && sameHex(observed.orderId, id)
    && sameHex(source.termsHash, hash) && sameHex(observed.termsHash, hash) && sameHex(observed.receipt.termsHash, hash),
  "complete terms, identity or terms hash disagree");
  requireInput(typeof observed.receipt.filledQuantity === "bigint" && observed.receipt.filledQuantity === 0n, "Cancelled quantity must be bigint zero");
  requireInput(sameHex(observed.receiptHash, receiptHash({ termsHash: hash, terminal: 2, filledQuantity: observed.receipt.filledQuantity })),
    "receipt hash disagrees");
  for (const value of [observed.transactionHash, observed.inclusion.hash, observed.observationHead.hash]) {
    requireInput(BigInt(hex(raw(value, 32))) !== 0n, "zero confirmation identity");
  }
  requireInput(typeof observed.inclusion.number === "bigint" && observed.inclusion.number >= 0n && observed.inclusion.number < (1n << 256n)
    && typeof observed.observationHead.number === "bigint" && observed.observationHead.number >= 0n && observed.observationHead.number < (1n << 256n)
    && typeof observed.additionalBlocks === "bigint" && observed.additionalBlocks >= 2n
    && observed.observationHead.number - observed.inclusion.number === observed.additionalBlocks
    && !sameHex(observed.observationHead.hash, raw(observed.inclusion.hash, 32)), "invalid confirmation metadata");

  const programId = new PublicKey(d.solanaProgram);
  requireInput(programId.toBase58() === "7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK"
    && program.programId.equals(programId) && program.idl.address === programId.toBase58(), "program/IDL binding");
  const s = cfg.solana, c = s.config;
  const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId);
  const [config, configBump] = pda(Buffer.from("config"));
  const [accounting, accountingBump] = pda(Buffer.from("accounting"), config.toBytes());
  const [yesAuthority, yesBump] = pda(Buffer.from("yes-authority"), config.toBytes());
  requireInput(s.commitment === "finalized" && safeSlot(s.contextSlot) && safeSlot(s.minContextSlot)
    && s.contextSlot >= s.minContextSlot && source.contextSlot >= s.minContextSlot
    && s.program.address === programId.toBase58() && s.program.executable === true && s.program.upgradeAuthority === null
    && c.owner === programId.toBase58() && c.address === config.toBase58() && c.bump === configBump
    && c.version === 1 && c.outcome === 0 && c.yesAuthority === yesAuthority.toBase58() && c.yesAuthorityBump === yesBump
    && s.accounting.address === accounting.toBase58() && s.accounting.owner === programId.toBase58()
    && s.accounting.config === config.toBase58() && s.accounting.bump === accountingBump, "source configuration accounts");
  requireInput(isDeepStrictEqual(s.configuration, cfg.evm.configuration) && cfg.evm.rpcChainId === "31337"
    && s.configuration.chainId === d.chainId.toString() && d.chainId === 31337n, "shared configuration/chain");
  for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "settlement"] as const) {
    requireInput(sameHex(s.configuration[field], Buffer.from(d[field])), `deployment ${field}`);
  }
  requireInput(sameHex(s.configuration.market, Buffer.from(t.market)), "configured market");
  requireInput(d.sourceDomain.some((byte) => byte !== 0) && d.destinationDomain.some((byte) => byte !== 0)
    && !Buffer.from(d.sourceDomain).equals(Buffer.from(d.destinationDomain)) && t.market.some((byte) => byte !== 0),
  "nonzero/distinct domains and market");
  const evmAddresses = ["settlement", "venue", "cashToken", "yesToken", "evmOperator", "evmExecutor"] as const;
  for (const field of evmAddresses) {
    requireInput(raw(s.configuration[field], 20).some((byte) => byte !== 0), `nonzero deployment ${field}`);
  }
  requireInput(!sameHex(s.configuration.cashToken, raw(s.configuration.yesToken, 20))
    && !sameHex(s.configuration.evmOperator, raw(s.configuration.evmExecutor, 20)), "distinct EVM tokens/roles");
  requireInput(typeof c.dataHex === "string" && /^[0-9a-fA-F]{1160}$/.test(c.dataHex), "Config bytes");
  const decoded = program.coder.accounts.decode("config", Buffer.from(c.dataHex, "hex"));
  for (const [field, value] of Object.entries({ sourceDomain: d.sourceDomain, destinationDomain: d.destinationDomain,
    chainId: raw(`0x${d.chainId.toString(16).padStart(64, "0")}`, 32), settlement: d.settlement, market: t.market })) {
    requireInput(Buffer.from(decoded[field]).equals(Buffer.from(value)), `Config bytes ${field}`);
  }
  for (const field of ["venue", "cashToken", "yesToken", "evmOperator", "evmExecutor"] as const) {
    requireInput(sameHex(s.configuration[field], Buffer.from(decoded[field])), `Config bytes ${field}`);
  }
  requireInput(decoded.version === 1 && decoded.outcome === 0 && decoded.bump === configBump
    && decoded.yesAuthorityBump === yesBump && decoded.solanaProgram.equals(programId), "decoded Config identity");
  for (const [field, value] of Object.entries({ solanaOperator: c.operator, solanaExecutor: c.executor, cashMint: c.cashMint,
    yesMint: c.yesMint, executorCashAta: c.executorCashAta, yesMintAuthority: c.yesAuthority,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    systemProgram: SystemProgram.programId.toBase58() })) {
    requireInput(decoded[field].equals(new PublicKey(value)), `Config bytes ${field}`);
  }
  requireInput(c.tokenProgram === TOKEN_PROGRAM_ID.toBase58() && c.associatedTokenProgram === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
    && c.systemProgram === SystemProgram.programId.toBase58(), "legacy programs");
  const user = new PublicKey(t.identity.user), operator = new PublicKey(c.operator), executor = new PublicKey(c.executor);
  const cashMint = new PublicKey(c.cashMint), yesMint = new PublicKey(c.yesMint);
  requireInput(!user.equals(PublicKey.default) && !operator.equals(PublicKey.default) && !executor.equals(PublicKey.default)
    && !user.equals(operator) && !user.equals(executor) && !operator.equals(executor) && !cashMint.equals(yesMint), "roles/mints");
  const nonceSeed = Buffer.alloc(8); nonceSeed.writeBigUInt64BE(t.identity.nonce);
  const [userNonce] = pda(Buffer.from("user"), config.toBytes(), user.toBytes());
  const [order] = pda(Buffer.from("order"), config.toBytes(), user.toBytes(), nonceSeed);
  const [escrow] = pda(Buffer.from("escrow"), order.toBytes());
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCashAta = ata(cashMint, user), userYesAta = ata(yesMint, user), executorCashAta = ata(cashMint, executor);
  requireInput(c.executorCashAta === executorCashAta.toBase58(), "executor ATA");
  for (const [name, key] of Object.entries({ config, userNonce, order, escrow, userCashAta, userYesAta })) {
    requireInput(source.accounts[name as keyof typeof source.accounts] === key.toBase58(), `source ${name}`);
  }
  const accounts = { operator, user, config, accounting, userNonce, order, cashMint,
    userCashAta, escrow, tokenProgram: TOKEN_PROGRAM_ID };
  requireInput(new Set(Object.values(accounts).map((key) => key.toBase58())).size === 10, "unsafe account alias");
  const bn = (value: bigint) => new BN(value.toString(10));
  return program.methods.acceptCancelled({ terms: { domain: { sourceDomain: [...d.sourceDomain], destinationDomain: [...d.destinationDomain],
    solanaProgram: programId, chainId: [...raw(`0x${d.chainId.toString(16).padStart(64, "0")}`, 32)], settlement: [...d.settlement] },
  user, nonce: bn(t.identity.nonce), market: [...t.market], outcome: 0, cashAmount: bn(t.cashAmount), minimumShares: bn(t.minimumShares) },
  receipt: { termsHash: [...hash], terminal: 2, filledQuantity: bn(observed.receipt.filledQuantity) } }).accountsStrict(accounts).instruction();
}
