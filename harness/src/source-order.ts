import { readFileSync } from "node:fs";
import { BorshAccountsCoder, convertIdlToCamelCase, type Idl, type IdlAccounts } from "@anchor-lang/core";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
import type { SettlementLab } from "../../solana/target/types/settlement_lab.ts";
import type { LiveConfigurationObservation } from "./live-configuration.ts";
import type { Terms } from "./protocol-encoding.ts";
const { orderId, termsHash } = await import(new URL("./protocol-encoding.ts", import.meta.url).href) as typeof import("./protocol-encoding.ts");

/** Fixed widths are checked by the adapter before constructing these values. */
export type Bytes32Hex = `0x${string}` & { readonly __bytes: 32 };
export type EvmAddressHex = `0x${string}` & { readonly __bytes: 20 };
export type EvmTerms = {
  identity: {
    domain: { sourceDomain: Bytes32Hex; destinationDomain: Bytes32Hex; solanaProgram: Bytes32Hex;
      chainId: bigint; settlement: EvmAddressHex };
    user: Bytes32Hex;
    nonce: bigint;
  };
  market: Bytes32Hex;
  outcome: 0;
  cashAmount: bigint;
  minimumShares: bigint;
};

export type SourceOrderConnection = Pick<Connection, "getMultipleAccountsInfoAndContext">;
export type ReadFinalizedPendingOrderInput = {
  readonly connection: SourceOrderConnection;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly user: PublicKey;
  readonly nonce: bigint;
  readonly minFinalizedSlot: number;
};
export type FinalizedPendingOrder = {
  accounts: { config: string; userNonce: string; order: string; escrow: string; userCashAta: string; userYesAta: string };
  contextSlot: number;
  state: "Pending";
  orderId: Bytes32Hex;
  termsHash: Bytes32Hex;
  escrowBalance: bigint;
  terms: EvmTerms;
};
export type ReadFinalizedCancellationRequestInput = ReadFinalizedPendingOrderInput;
export type FinalizedCancellationRequest = Omit<FinalizedPendingOrder, "state"> & {
  state: "CancelRequested";
  cancellationRequested: true;
};
export type SourceOrderErrorCode = "InvalidInput" | "ConfigurationMismatch" | "MissingAccount" | "InvalidAccount"
  | "InvalidBinding" | "InvalidAmounts" | "HashMismatch" | "NotPending" | "InconsistentPending"
  | "NotCancelRequested" | "InconsistentCancellationRequest"
  | "StaleContext" | "RpcTimeout";
export class SourceOrderError extends Error {
  readonly code: SourceOrderErrorCode;
  constructor(code: SourceOrderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceOrderError";
    this.code = code;
  }
}

const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const idl = JSON.parse(readFileSync(new URL("../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as Idl;
if (idl.address !== programId.toBase58()) throw new SourceOrderError("ConfigurationMismatch", "IDL program identity differs from repository program");
const coder = new BorshAccountsCoder(convertIdlToCamelCase(idl));
type Accounts = IdlAccounts<SettlementLab>;
const U64_MAX = (1n << 64n) - 1n;
function requireOrder(condition: boolean, code: SourceOrderErrorCode, message: string): asserts condition {
  if (!condition) throw new SourceOrderError(code, message);
}
function hex<Width extends 20 | 32>(bytes: Uint8Array | readonly number[], width: Width): `0x${string}` & { readonly __bytes: Width } {
  requireOrder(bytes.length === width, "InvalidAccount", `Expected ${width} bytes`);
  return `0x${Buffer.from(bytes).toString("hex")}` as `0x${string}` & { readonly __bytes: Width };
}

/** Read-only observation under the explicitly trusted operator model. The caller
 * supplies verifyLiveConfiguration's trusted observation; its TS type is not a
 * cryptographic proof. Config is re-read and compared byte-for-byte.
 * A finalized observation is not a lock or an execution promise. Later broadcast
 * must reconcile cancellation races and destination terminal records.
 * RPC failures propagate unchanged; the single RPC has a 10-second deadline
 * (a timeout does not cancel the underlying connection request).
 */
export async function readFinalizedPendingOrder(input: ReadFinalizedPendingOrderInput): Promise<FinalizedPendingOrder> {
  return { ...await readFinalizedSourceOrder(input, "Pending"), state: "Pending" };
}

/** Observes program state under the trusted RPC/configuration model. The on-chain
 * request_cancel transition enforces the original user's signature; this adapter
 * does not independently verify it. CancelRequested records intent, not proof of
 * destination cancellation. Neither this observation nor a timeout authorizes a
 * refund: a later EVM Filled outcome remains possible and must be reconciled.
 */
export async function readFinalizedCancellationRequest(input: ReadFinalizedCancellationRequestInput): Promise<FinalizedCancellationRequest> {
  return { ...await readFinalizedSourceOrder(input, "CancelRequested"), state: "CancelRequested", cancellationRequested: true };
}

async function readFinalizedSourceOrder(
  input: ReadFinalizedPendingOrderInput,
  requiredState: "Pending" | "CancelRequested",
): Promise<Omit<FinalizedPendingOrder, "state">> {
  const { connection, nonce, minFinalizedSlot } = input;
  requireOrder(Number.isSafeInteger(minFinalizedSlot) && minFinalizedSlot > 0, "InvalidInput", "minFinalizedSlot must be a positive safe integer");
  requireOrder(typeof nonce === "bigint" && nonce >= 0n && nonce < U64_MAX, "InvalidInput", "nonce must be bigint in 0..=u64::MAX-1");
  requireOrder(input.user instanceof PublicKey && !input.user.equals(PublicKey.default), "InvalidInput", "user must be a nonzero PublicKey");
  const user = new PublicKey(input.user.toBytes());
  // Snapshot trusted inputs before awaiting RPC; never retain caller-owned values.
  const expected = structuredClone(input.expectedConfiguration.solana);
  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  requireOrder(expected.program.address === programId.toBase58()
    && expected.config.owner === programId.toBase58() && expected.config.address === config.toBase58(),
  "ConfigurationMismatch", "Expected repository program and canonical Config");
  requireOrder(typeof expected.config.dataHex === "string" && /^[0-9a-fA-F]{1160}$/.test(expected.config.dataHex),
    "ConfigurationMismatch", "Expected exact 580-byte Config observation");
  const expectedBytes = Buffer.from(expected.config.dataHex, "hex");
  const nonceSeed = Buffer.alloc(8);
  nonceSeed.writeBigUInt64BE(nonce);
  const [userNonce, userBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], programId);
  const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), nonceSeed], programId);
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await (async () => {
    try {
      return await Promise.race([
        connection.getMultipleAccountsInfoAndContext([config, userNonce, order, escrow], { commitment: "finalized", minContextSlot: minFinalizedSlot }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SourceOrderError("RpcTimeout", "Finalized source order RPC deadline exceeded")), 10_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  })();
  requireOrder(Number.isSafeInteger(response.context.slot) && response.context.slot >= minFinalizedSlot,
    "StaleContext", "Finalized response context is below the required slot or invalid");
  requireOrder(response.value.length === 4, "InvalidAccount", "Expected four source account records");
  function account(index: number, owner: PublicKey, size: number, label: string): AccountInfo<Buffer> {
    const info = response.value[index];
    requireOrder(info != null, "MissingAccount", `${label} is missing`);
    requireOrder(info.owner.equals(owner) && info.executable === false && info.data.length === size,
      "InvalidAccount", `${label} owner, executable flag or allocated size is invalid`);
    return info;
  }
  function decode<Name extends "config" | "userNonce" | "order">(name: Name, info: AccountInfo<Buffer>): Accounts[Name] {
    try { return coder.decode<Accounts[Name]>(name, info.data); }
    catch (cause) { throw new SourceOrderError("InvalidAccount", `${name} discriminator or Borsh data is invalid`, { cause }); }
  }
  const configInfo = account(0, programId, 580, "Config");
  const c = decode("config", configInfo);
  requireOrder(configInfo.data.equals(expectedBytes), "ConfigurationMismatch", "Config bytes differ from the verified observation");
  requireOrder(c.version === 1 && c.outcome === 0 && c.solanaProgram.equals(programId) && c.bump === configBump
    && c.tokenProgram.equals(TOKEN_PROGRAM_ID) && c.associatedTokenProgram.equals(ASSOCIATED_TOKEN_PROGRAM_ID)
    && c.systemProgram.equals(SystemProgram.programId), "ConfigurationMismatch", "Config identity or token programs are invalid");
  requireOrder(!user.equals(c.solanaOperator) && !user.equals(c.solanaExecutor), "InvalidInput", "user is a reserved source role");
  const n = decode("userNonce", account(1, programId, 81, "UserNonce"));
  requireOrder(n.config.equals(config) && n.user.equals(user) && n.bump === userBump && BigInt(n.nextNonce.toString()) > nonce,
    "InvalidBinding", "UserNonce relationship, bump or permanent counter is invalid");
  const orderInfo = account(2, programId, 335, "Order");
  // Strict Borsh tags; bool decoders need not reject noncanonical byte values.
  // Some occupies 42 bytes including its tag; None occupies one. The IDL coder
  // locates bumps accordingly and ignores the remaining allocated padding.
  requireOrder(orderInfo.data[289] <= 3 && orderInfo.data[290] <= 1 && orderInfo.data[291] <= 1,
    "InvalidAccount", "Order state, bool or Option tag is invalid");
  const o = decode("order", orderInfo);
  requireOrder(o.config.equals(config) && o.user.equals(user) && BigInt(o.nonce.toString()) === nonce
    && o.bump === orderBump && o.escrowBump === escrowBump && o.escrow.equals(escrow),
  "InvalidBinding", "Order identity, escrow or canonical bumps are invalid");
  requireOrder(Buffer.from(o.market).equals(Buffer.from(c.market)) && o.outcome === c.outcome,
    "InvalidBinding", "Order market or YES outcome differs from Config");
  const cashAmount = BigInt(o.cashAmount.toString());
  const minimumShares = BigInt(o.minimumShares.toString());
  requireOrder(cashAmount >= 1n && cashAmount <= U64_MAX / 2n && minimumShares >= 1n && minimumShares <= U64_MAX,
    "InvalidAmounts", "Order cash or minimum shares is outside uint64 policy bounds");
  const ata = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCashAta = ata(c.cashMint);
  const userYesAta = ata(c.yesMint);
  requireOrder(o.userCashAta.equals(userCashAta) && o.userYesAta.equals(userYesAta), "InvalidBinding", "Stored user ATAs are not canonical");
  const terms: Terms = {
    identity: { domain: { sourceDomain: Uint8Array.from(c.sourceDomain), destinationDomain: Uint8Array.from(c.destinationDomain),
      solanaProgram: c.solanaProgram.toBytes(), chainId: BigInt(hex(c.chainId, 32)), settlement: Uint8Array.from(c.settlement) },
    user: o.user.toBytes(), nonce },
    market: Uint8Array.from(o.market), outcome: o.outcome, cashAmount, minimumShares,
  };
  const canonicalId = orderId(terms.identity);
  const canonicalHash = termsHash(terms);
  requireOrder(canonicalId.equals(Buffer.from(o.orderId)) && canonicalHash.equals(Buffer.from(o.termsHash)),
    "HashMismatch", "Stored order ID or terms hash differs from canonical SHA-256");
  const escrowInfo = account(3, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, "Escrow");
  const state = Object.keys(o.state)[0];
  if (requiredState === "Pending") {
    requireOrder(state === "pending", "NotPending", `Order is ${state}; new execution requires Pending`);
    requireOrder(o.cancellationRequested === false && o.acceptedReceipt === null,
      "InconsistentPending", "Pending order has a cancellation request or accepted receipt");
  } else {
    requireOrder(state === "cancelRequested", "NotCancelRequested", `Order is ${state}; cancellation observation requires CancelRequested`);
    requireOrder(o.cancellationRequested === true && o.acceptedReceipt === null,
      "InconsistentCancellationRequest", "CancelRequested order lacks cancellation intent or has an accepted receipt");
  }
  // Terminal orders may have empty escrow following settlement/refund. Reject
  // their eligibility above rather than classifying valid paid-out records as corrupt.
  requireOrder(escrowInfo.data[108] === 1 && [72, 109, 129].every((offset) => escrowInfo.data.readUInt32LE(offset) === 0),
    "InvalidBinding", "Escrow must be initialized with no delegate, native state or close authority");
  const token = unpackAccount(escrow, escrowInfo, TOKEN_PROGRAM_ID);
  requireOrder(token.owner.equals(order) && token.mint.equals(c.cashMint) && token.isInitialized && !token.isFrozen
    && !token.isNative && token.delegate === null && token.delegatedAmount === 0n && token.closeAuthority === null,
  "InvalidBinding", "Escrow authority, mint or token state is unsafe");
  requireOrder(token.amount >= cashAmount, "InvalidAmounts", "Escrow balance is below the order deposit");
  return {
    accounts: { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
      userCashAta: userCashAta.toBase58(), userYesAta: userYesAta.toBase58() },
    contextSlot: response.context.slot, orderId: hex(canonicalId, 32), termsHash: hex(canonicalHash, 32), escrowBalance: token.amount,
    terms: { identity: { domain: { sourceDomain: hex(terms.identity.domain.sourceDomain, 32), destinationDomain: hex(terms.identity.domain.destinationDomain, 32),
      solanaProgram: hex(terms.identity.domain.solanaProgram, 32), chainId: terms.identity.domain.chainId, settlement: hex(terms.identity.domain.settlement, 20) },
    user: hex(terms.identity.user, 32), nonce }, market: hex(terms.market, 32), outcome: 0, cashAmount, minimumShares },
  };
}
