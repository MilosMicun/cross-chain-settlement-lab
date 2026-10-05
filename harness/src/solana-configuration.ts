import { PublicKey } from "@solana/web3.js";
import { getAddress, getBytes, isHexString } from "ethers";
import type { EvmDeploymentManifest } from "./evm-deployment.ts";

export type SolanaInitializeArgs = {
  sourceDomain: number[];
  destinationDomain: number[];
  chainId: number[];
  settlement: number[];
  venue: number[];
  cashToken: number[];
  yesToken: number[];
  evmOperator: number[];
  evmExecutor: number[];
  market: number[];
  solanaOperator: PublicKey;
  solanaExecutor: PublicKey;
};

function nonzeroHex(value: unknown, width: number, field: string): number[] {
  if (typeof value !== "string" || !isHexString(value, width)) {
    throw new Error(`${field} must be a 0x-prefixed ${width}-byte hex string`);
  }
  const bytes = Array.from(getBytes(value));
  if (!bytes.some((byte) => byte !== 0)) throw new Error(`${field} must be nonzero`);
  return bytes;
}

function addressBytes(value: unknown, field: string): number[] {
  const bytes = nonzeroHex(value, 20, field);
  try {
    getAddress(value as string);
  } catch {
    throw new Error(`${field} must be a valid EVM address`);
  }
  return bytes;
}

function equalBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nonzeroKey(value: PublicKey, field: string): void {
  if (!(value instanceof PublicKey) || value.equals(PublicKey.default)) {
    throw new Error(`${field} must be a nonzero PublicKey`);
  }
}

function chainBytes(value: unknown): number[] {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("chainId must be a canonical positive decimal string");
  }
  // A uint256 has at most 78 decimal digits; never narrow the full value to Number.
  if (value.length > 78 || BigInt(value) >= (1n << 256n)) {
    throw new Error("chainId must fit uint256");
  }
  let remaining = BigInt(value);
  const bytes = Array<number>(32).fill(0);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

/** Offline representation and supplied-binding checks only. This cannot prove
 * EVM contract existence, receipts, finality, or on-chain agreement. Deployment
 * domains are preserved verbatim as bytes; the program sets its own identity.
 * Full uint256 conversion does not authorize deployment beyond local chain 31337.
 */
export function buildInitializeArgs(
  manifest: EvmDeploymentManifest,
  programId: PublicKey,
  solanaOperator: PublicKey,
  solanaExecutor: PublicKey,
): SolanaInitializeArgs {
  if (manifest.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (manifest.outcome !== 0) throw new Error("outcome must be 0 (YES)");
  if (manifest.tokenDecimals !== 6) throw new Error("tokenDecimals must be 6");

  const sourceDomain = nonzeroHex(manifest.sourceDomain, 32, "sourceDomain");
  const destinationDomain = nonzeroHex(manifest.destinationDomain, 32, "destinationDomain");
  const market = nonzeroHex(manifest.market, 32, "market");
  const solanaProgram = nonzeroHex(manifest.solanaProgram, 32, "solanaProgram");
  if (equalBytes(sourceDomain, destinationDomain)) throw new Error("Deployment domains must be distinct");
  nonzeroKey(programId, "programId");
  if (!equalBytes(solanaProgram, Array.from(programId.toBytes()))) {
    throw new Error("solanaProgram must match programId");
  }
  const chainId = chainBytes(manifest.chainId);
  const settlement = addressBytes(manifest.contracts.settlement, "settlement");
  const venue = addressBytes(manifest.contracts.venue, "venue");
  const cashToken = addressBytes(manifest.contracts.usd, "cashToken");
  const yesToken = addressBytes(manifest.contracts.yes, "yesToken");
  const evmOperator = addressBytes(manifest.roles.operator, "evmOperator");
  const evmExecutor = addressBytes(manifest.roles.executor, "evmExecutor");
  if (equalBytes(cashToken, yesToken)) throw new Error("EVM cash and YES tokens must be distinct");
  if (equalBytes(evmOperator, evmExecutor)) throw new Error("EVM operator and executor must be distinct");
  nonzeroKey(solanaOperator, "solanaOperator");
  nonzeroKey(solanaExecutor, "solanaExecutor");
  if (solanaOperator.equals(solanaExecutor)) throw new Error("Solana operator and executor must be distinct");

  return {
    sourceDomain, destinationDomain, chainId, settlement, venue, cashToken, yesToken,
    evmOperator, evmExecutor, market, solanaOperator, solanaExecutor,
  };
}
