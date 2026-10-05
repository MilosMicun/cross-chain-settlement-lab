import { createHash } from "node:crypto";

/** Raw decoded bytes only; address strings must be decoded by an adapter. */
export type Domain = {
  readonly sourceDomain: Uint8Array;
  readonly destinationDomain: Uint8Array;
  readonly solanaProgram: Uint8Array;
  readonly chainId: bigint;
  readonly settlement: Uint8Array;
};

export type Identity = {
  readonly domain: Domain;
  readonly user: Uint8Array;
  readonly nonce: bigint;
};

export type Terms = {
  readonly identity: Identity;
  readonly market: Uint8Array;
  readonly outcome: number;
  readonly cashAmount: bigint;
  readonly minimumShares: bigint;
};

export type Receipt = {
  readonly termsHash: Uint8Array;
  readonly terminal: number;
  readonly filledQuantity: bigint;
};

export class EncodingError extends Error {
  readonly code: "InvalidBytes" | "InvalidInteger" | "InvalidTerminal";

  constructor(code: EncodingError["code"], message: string) {
    super(message);
    this.name = "EncodingError";
    this.code = code;
  }
}

function fixedBytes(value: Uint8Array, width: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== width) {
    throw new EncodingError("InvalidBytes", `${field} must be a ${width}-byte Uint8Array`);
  }
  return value;
}

function unsignedBigEndian(value: bigint, width: number, field: string): Buffer {
  if (typeof value !== "bigint" || value < 0n || value >= (1n << BigInt(width * 8))) {
    throw new EncodingError("InvalidInteger", `${field} must be an unsigned ${width * 8}-bit bigint`);
  }
  const bytes = Buffer.alloc(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function uint8(value: number, field: string): Buffer {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new EncodingError("InvalidInteger", `${field} must be an unsigned 8-bit integer number`);
  }
  const bytes = Buffer.alloc(1);
  bytes[0] = value;
  return bytes;
}

// Unpooled buffers own their backing memory, including across separate calls.
function concatenate(parts: readonly Uint8Array[]): Buffer {
  const bytes = Buffer.alloc(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function domainBytes(domain: Domain): Buffer {
  return concatenate([
    fixedBytes(domain.sourceDomain, 32, "sourceDomain"),
    fixedBytes(domain.destinationDomain, 32, "destinationDomain"),
    fixedBytes(domain.solanaProgram, 32, "solanaProgram"),
    unsignedBigEndian(domain.chainId, 32, "chainId"),
    fixedBytes(domain.settlement, 20, "settlement"),
  ]);
}

/** Canonical v1 identity preimage: 196 bytes, with unsigned big-endian integers. */
export function identityBytes(identity: Identity): Buffer {
  return concatenate([
    Buffer.from("CCSLID01", "ascii"),
    domainBytes(identity.domain),
    fixedBytes(identity.user, 32, "user"),
    unsignedBigEndian(identity.nonce, 8, "nonce"),
  ]);
}

// Hashes bind content; they do not prove authorization, execution, or finality.
function sha256(bytes: Buffer): Buffer {
  const result = Buffer.alloc(32);
  result.set(createHash("sha256").update(bytes).digest());
  return result;
}

export function orderId(identity: Identity): Buffer {
  return sha256(identityBytes(identity));
}

/** Canonical v1 terms preimage: 277 bytes, including the derived order ID.
 * Representation checks do not enforce deployment, nonce, market, or amount policy.
 */
export function termsBytes(terms: Terms): Buffer {
  return concatenate([
    Buffer.from("CCSLTR01", "ascii"),
    domainBytes(terms.identity.domain),
    orderId(terms.identity),
    fixedBytes(terms.identity.user, 32, "user"),
    unsignedBigEndian(terms.identity.nonce, 8, "nonce"),
    fixedBytes(terms.market, 32, "market"),
    uint8(terms.outcome, "outcome"),
    unsignedBigEndian(terms.cashAmount, 8, "cashAmount"),
    unsignedBigEndian(terms.minimumShares, 8, "minimumShares"),
  ]);
}

export function termsHash(terms: Terms): Buffer {
  return sha256(termsBytes(terms));
}

/** Canonical v1 receipt preimage: 49 bytes, for Filled (1) or Cancelled (2).
 * Quantity semantics and evidence of execution belong to business validation.
 */
export function receiptBytes(receipt: Receipt): Buffer {
  const terminal = uint8(receipt.terminal, "terminal");
  if (receipt.terminal !== 1 && receipt.terminal !== 2) {
    throw new EncodingError("InvalidTerminal", "terminal must be Filled (1) or Cancelled (2)");
  }
  return concatenate([
    Buffer.from("CCSLRC01", "ascii"),
    fixedBytes(receipt.termsHash, 32, "termsHash"),
    terminal,
    unsignedBigEndian(receipt.filledQuantity, 8, "filledQuantity"),
  ]);
}

export function receiptHash(receipt: Receipt): Buffer {
  return sha256(receiptBytes(receipt));
}
