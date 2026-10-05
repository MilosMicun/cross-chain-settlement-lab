import type { Bytes32Hex, FinalizedRecoveryOrder } from "./source-order.ts";
import type { TerminalObservationResult } from "./terminal-observation.ts";
import type { Terms } from "./protocol-encoding.ts";
const { orderId, termsHash, termsBytes, receiptHash } = await import(new URL("./protocol-encoding.ts", import.meta.url).href) as typeof import("./protocol-encoding.ts");

export type PlanRecoveryInput = {
  readonly source: FinalizedRecoveryOrder;
  readonly destination: TerminalObservationResult | null;
};

type PlanIdentity = { readonly orderId: Bytes32Hex; readonly termsHash: Bytes32Hex };
export type RecoveryPlan = PlanIdentity & (
  | { readonly kind: "Wait"; readonly reason: "DestinationNotObserved" | "DestinationNotConfirmed" | "SourceCancellationRequired" }
  | { readonly kind: "DeliverFilled"; readonly receiptHash: Bytes32Hex }
  | { readonly kind: "DeliverCancelled"; readonly receiptHash: Bytes32Hex }
  | { readonly kind: "Complete"; readonly sourceState: "Settled" | "Refunded"; readonly receiptHash: Bytes32Hex }
);

export class RecoveryPlanError extends Error {
  readonly code: "InvalidInput" | "InvalidSource" | "InvalidDestination" | "BindingMismatch" | "TerminalConflict";
  constructor(code: RecoveryPlanError["code"], message: string) {
    super(message);
    this.name = "RecoveryPlanError";
    this.code = code;
  }
}

type ErrorCode = RecoveryPlanError["code"];
const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
function requireValid(condition: boolean, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new RecoveryPlanError(code, message);
}
function object(value: unknown, code: ErrorCode, label: string): Record<string, unknown> {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object`);
  return value as Record<string, unknown>;
}
function raw(value: unknown, width: number, code: ErrorCode, label: string): Buffer {
  requireValid(typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${width * 2}}$`).test(value), code, `${label} must contain ${width} hex bytes`);
  return Buffer.from(value.slice(2), "hex");
}
function uint(value: unknown, maximum: bigint, code: ErrorCode, label: string): bigint {
  requireValid(typeof value === "bigint" && value >= 0n && value <= maximum, code, `${label} must be an unsigned bounded bigint`);
  return value;
}
const hex = (bytes: Buffer): Bytes32Hex => `0x${bytes.toString("hex")}` as Bytes32Hex;

function canonicalTerms(value: unknown, code: ErrorCode): Terms {
  const t = object(value, code, "terms");
  const i = object(t.identity, code, "identity");
  const d = object(i.domain, code, "domain");
  const user = raw(i.user, 32, code, "user");
  requireValid(user.some((byte) => byte !== 0), code, "user must be nonzero");
  const nonce = uint(i.nonce, U64_MAX - 1n, code, "nonce");
  const cashAmount = uint(t.cashAmount, U64_MAX / 2n, code, "cashAmount");
  const minimumShares = uint(t.minimumShares, U64_MAX, code, "minimumShares");
  requireValid(t.outcome === 0 && cashAmount > 0n && minimumShares > 0n, code, "Requires YES and positive cash/minimum amounts");
  return {
    identity: { domain: {
      sourceDomain: raw(d.sourceDomain, 32, code, "sourceDomain"),
      destinationDomain: raw(d.destinationDomain, 32, code, "destinationDomain"),
      solanaProgram: raw(d.solanaProgram, 32, code, "solanaProgram"),
      chainId: uint(d.chainId, U256_MAX, code, "chainId"),
      settlement: raw(d.settlement, 20, code, "settlement"),
    }, user, nonce },
    market: raw(t.market, 32, code, "market"), outcome: 0, cashAmount, minimumShares,
  };
}

function validateBindings(record: Record<string, unknown>, terms: Terms, code: ErrorCode) {
  const id = orderId(terms.identity), hash = termsHash(terms);
  requireValid(raw(record.orderId, 32, code, "orderId").equals(id)
    && raw(record.termsHash, 32, code, "termsHash").equals(hash),
  "BindingMismatch", "Order ID or terms hash differs from complete canonical terms");
  return { id, hash };
}

function validateReceipt(value: unknown, hashValue: unknown, terms: Terms, hash: Buffer, code: ErrorCode) {
  const receipt = object(value, code, "receipt");
  const terminal = receipt.terminal;
  requireValid(terminal === 1 || terminal === 2, code, "Unrecognized receipt terminal");
  const filledQuantity = uint(receipt.filledQuantity, U64_MAX, code, "filledQuantity");
  requireValid(terminal === 1
    ? filledQuantity === 2n * terms.cashAmount && filledQuantity >= terms.minimumShares
    : filledQuantity === 0n, code, "Invalid terminal quantity or unsatisfied fill minimum");
  const canonicalHash = receiptHash({ termsHash: hash, terminal, filledQuantity });
  requireValid(raw(hashValue, 32, code, "receiptHash").equals(canonicalHash), code, "Receipt hash differs from canonical receipt");
  return { terminal, filledQuantity, hash: canonicalHash };
}

function validateSource(value: unknown) {
  const source = object(value, "InvalidSource", "source");
  const state = source.state;
  requireValid(state === "Pending" || state === "CancelRequested" || state === "Settled" || state === "Refunded",
    "InvalidSource", "Unrecognized source lifecycle state");
  requireValid(typeof source.cancellationRequested === "boolean", "InvalidSource", "Cancellation flag must be boolean");
  requireValid(typeof source.contextSlot === "number" && Number.isSafeInteger(source.contextSlot) && source.contextSlot > 0,
    "InvalidSource", "Context slot must be a positive safe integer");
  const balance = uint(source.escrowBalance, U64_MAX, "InvalidSource", "escrowBalance");
  const terms = canonicalTerms(source.terms, "InvalidSource");
  const { id, hash } = validateBindings(source, terms, "InvalidSource");
  let accepted = null;
  if (state === "Pending" || state === "CancelRequested") {
    requireValid(source.cancellationRequested === (state === "CancelRequested") && source.acceptedReceipt === null,
      "InvalidSource", "Active lifecycle has inconsistent cancellation or receipt fields");
    requireValid(balance >= terms.cashAmount, "InvalidSource", "Active escrow is below cashAmount");
  } else {
    const receipt = object(source.acceptedReceipt, "InvalidSource", "acceptedReceipt");
    accepted = validateReceipt(receipt, receipt.receiptHash, terms, hash, "InvalidSource");
    requireValid(state === "Settled" ? accepted.terminal === 1
      : source.cancellationRequested === true && accepted.terminal === 2,
    "InvalidSource", "Terminal lifecycle disagrees with cancellation or accepted receipt");
  }
  return { state, terms, id, hash, accepted };
}

function validateDestination(destination: Record<string, unknown>, source: ReturnType<typeof validateSource>) {
  const terms = canonicalTerms(destination.terms, "InvalidDestination");
  const { id, hash } = validateBindings(destination, terms, "InvalidDestination");
  // Compare the complete canonical encoding, not just its digest or order ID.
  requireValid(termsBytes(terms).equals(termsBytes(source.terms)) && id.equals(source.id) && hash.equals(source.hash),
    "BindingMismatch", "Destination terms differ from the source");
  const receipt = object(destination.receipt, "InvalidDestination", "destination receipt");
  requireValid(raw(receipt.termsHash, 32, "InvalidDestination", "receipt termsHash").equals(hash),
    "BindingMismatch", "Receipt terms hash differs from the order");
  const validated = validateReceipt(receipt, destination.receiptHash, terms, hash, "InvalidDestination");
  const inclusion = object(destination.inclusion, "InvalidDestination", "inclusion");
  const head = object(destination.observationHead, "InvalidDestination", "observationHead");
  const transactionHash = raw(destination.transactionHash, 32, "InvalidDestination", "transactionHash");
  const inclusionHash = raw(inclusion.hash, 32, "InvalidDestination", "inclusion hash");
  const headHash = raw(head.hash, 32, "InvalidDestination", "head hash");
  requireValid([transactionHash, inclusionHash, headHash].every((bytes) => bytes.some((byte) => byte !== 0))
    && !inclusionHash.equals(headHash), "InvalidDestination", "Confirmation hashes must be nonzero and blocks distinct");
  const inclusionNumber = uint(inclusion.number, U256_MAX, "InvalidDestination", "inclusion number");
  const headNumber = uint(head.number, U256_MAX, "InvalidDestination", "head number");
  const additionalBlocks = uint(destination.additionalBlocks, U256_MAX, "InvalidDestination", "additionalBlocks");
  requireValid(additionalBlocks >= 2n && additionalBlocks === headNumber - inclusionNumber,
    "InvalidDestination", "Confirmation requires the exact head/inclusion difference of at least two blocks");
  return validated;
}

/** Synchronous offline reconciliation of trusted adapter observations, not
 * cryptographic proofs. Plans are snapshots, not locks or transaction permissions.
 * A future executor must obtain appropriate fresh observations, validate the
 * instruction and reconcile its result. Local N+2 is not production finality.
 * Missing confirmation never authorizes execution, cancellation, refund or resend.
 * Account ownership, Config/Borsh/SPL decoding and authority checks stay with the
 * source reader and instruction builders. Outputs contain only owned primitives.
 */
export function planRecovery(input: PlanRecoveryInput): RecoveryPlan {
  const value = object(input, "InvalidInput", "input");
  const source = validateSource(value.source);
  const identity = { orderId: hex(source.id), termsHash: hex(source.hash) };
  if (value.destination === null) return { ...identity, kind: "Wait", reason: "DestinationNotObserved" };
  const destination = object(value.destination, "InvalidDestination", "destination");
  if (destination.kind === "NotConfirmed") {
    requireValid(destination.reason === "MissingReceipt" || destination.reason === "MissingTransaction"
      || destination.reason === "InsufficientAdditionalBlocks" || destination.reason === "CanonicalEvidenceUnavailable"
      || destination.reason === "CanonicalEvidenceChanged", "InvalidDestination", "Unrecognized NotConfirmed reason");
    return { ...identity, kind: "Wait", reason: "DestinationNotConfirmed" };
  }
  requireValid(destination.kind === "Confirmed", "InvalidDestination", "Unrecognized destination discriminant");
  const receipt = validateDestination(destination, source);
  if (source.state === "Settled" || source.state === "Refunded") {
    const accepted = source.accepted!;
    requireValid(accepted.terminal === receipt.terminal && accepted.filledQuantity === receipt.filledQuantity
      && accepted.hash.equals(receipt.hash), "TerminalConflict", "Source and destination terminal receipts conflict");
    return { ...identity, kind: "Complete", sourceState: source.state, receiptHash: hex(receipt.hash) };
  }
  if (receipt.terminal === 1) return { ...identity, kind: "DeliverFilled", receiptHash: hex(receipt.hash) };
  if (source.state === "Pending") return { ...identity, kind: "Wait", reason: "SourceCancellationRequired" };
  return { ...identity, kind: "DeliverCancelled", receiptHash: hex(receipt.hash) };
}
