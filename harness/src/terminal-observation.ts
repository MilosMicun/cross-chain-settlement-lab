import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Interface, getAddress, toQuantity } from "ethers";
import type { LiveConfigurationObservation, SharedConfiguration } from "./live-configuration.ts";
import type { Bytes32Hex, EvmTerms } from "./source-order.ts";
import type { Terms } from "./protocol-encoding.ts";
const { orderId, termsHash, receiptHash } = await import(new URL("./protocol-encoding.ts", import.meta.url).href) as typeof import("./protocol-encoding.ts");

export type TerminalReadMethod = "eth_chainId" | "eth_getTransactionReceipt" | "eth_getTransactionByHash"
  | "eth_getBlockByNumber" | "eth_call";
/** JsonRpcProvider.send is compatible; only these read methods are used. */
export type TerminalObservationRpc = {
  send(method: TerminalReadMethod, params: unknown[]): Promise<unknown>;
};
export type ObserveTerminalOutcomeInput = {
  readonly provider: TerminalObservationRpc;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly orderId: Bytes32Hex;
  readonly termsHash: Bytes32Hex;
  readonly terms: EvmTerms;
  readonly transactionHash: string;
};
export type TerminalObservationErrorCode = "InvalidInput" | "MalformedEvidence" | "FailedTransaction"
  | "BindingMismatch" | "RecordMismatch" | "RpcFailure" | "RequestDeadline" | "OverallDeadline";
export class TerminalObservationError extends Error {
  readonly code: TerminalObservationErrorCode;
  constructor(code: TerminalObservationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalObservationError";
    this.code = code;
  }
}
export type TerminalObservationResult = {
  kind: "NotConfirmed";
  reason: "MissingReceipt" | "MissingTransaction" | "InsufficientAdditionalBlocks" | "CanonicalEvidenceUnavailable" | "CanonicalEvidenceChanged";
} | {
  kind: "Confirmed";
  orderId: Bytes32Hex;
  termsHash: Bytes32Hex;
  terms: EvmTerms;
  receipt: { termsHash: Bytes32Hex; terminal: 1 | 2; filledQuantity: bigint };
  receiptHash: Bytes32Hex;
  transactionHash: Bytes32Hex;
  inclusion: { number: bigint; hash: Bytes32Hex };
  observationHead: { number: bigint; hash: Bytes32Hex };
  additionalBlocks: bigint;
};

const abi = new Interface(JSON.parse(readFileSync(new URL("../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);
const U64_MAX = (1n << 64n) - 1n;
function requireEvidence(ok: boolean, code: TerminalObservationErrorCode, message: string): asserts ok {
  if (!ok) throw new TerminalObservationError(code, message);
}
function hex(value: unknown, width: number, code: TerminalObservationErrorCode, label: string): string {
  requireEvidence(typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${width * 2}}$`).test(value), code, `${label}: expected ${width} bytes`);
  return value.toLowerCase();
}
function address(value: unknown, code: TerminalObservationErrorCode, label: string): string {
  const result = hex(value, 20, code, label);
  try { getAddress(value as string); } catch (cause) {
    throw new TerminalObservationError(code, `${label}: invalid address checksum`, { cause });
  }
  return result;
}
function quantity(value: unknown, label: string): bigint {
  requireEvidence(typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), "MalformedEvidence", `${label}: expected canonical RPC quantity`);
  const result = BigInt(value);
  requireEvidence(result < (1n << 256n), "MalformedEvidence", `${label}: exceeds uint256`);
  return result;
}
function object(value: unknown, label: string): Record<string, unknown> {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value), "MalformedEvidence", `${label}: expected object`);
  return value as Record<string, unknown>;
}
function shared(value: SharedConfiguration): SharedConfiguration {
  const result = { ...value };
  for (const key of ["sourceDomain", "destinationDomain", "solanaProgram", "market"] as const) {
    result[key] = hex(value[key], 32, "InvalidInput", key);
    requireEvidence(BigInt(result[key]) !== 0n, "InvalidInput", `${key}: zero binding`);
  }
  for (const key of ["settlement", "venue", "cashToken", "yesToken", "evmOperator", "evmExecutor"] as const) {
    result[key] = address(value[key], "InvalidInput", key);
    requireEvidence(BigInt(result[key]) !== 0n, "InvalidInput", `${key}: zero address`);
  }
  requireEvidence(value.chainId === "31337", "BindingMismatch", "Trusted configuration requires chain ID 31337");
  return result;
}
function canonicalTerms(t: EvmTerms): Terms {
  const raw = (value: unknown, width: number, label: string) => Buffer.from(hex(value, width, "InvalidInput", label).slice(2), "hex");
  const d = t.identity.domain;
  address(d.settlement, "InvalidInput", "terms settlement");
  return { identity: { domain: { sourceDomain: raw(d.sourceDomain, 32, "sourceDomain"),
    destinationDomain: raw(d.destinationDomain, 32, "destinationDomain"), solanaProgram: raw(d.solanaProgram, 32, "solanaProgram"),
    chainId: d.chainId, settlement: raw(d.settlement, 20, "settlement") }, user: raw(t.identity.user, 32, "user"), nonce: t.identity.nonce },
  market: raw(t.market, 32, "market"), outcome: t.outcome, cashAmount: t.cashAmount, minimumShares: t.minimumShares };
}
const asHex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}` as Bytes32Hex;

/** One bounded read-only attempt under the trusted-operator model. The caller's
 * verified configuration is trusted input, not a cryptographic proof. Only
 * Confirmed carries attestable content. Cancelled does not prove a finalized
 * source cancellation request and cannot independently authorize a refund.
 * No retries, mining, submissions, persistence or source receipt delivery.
 * Requests have 10-second deadlines within a 60-second overall deadline;
 * timing out does not cancel an underlying provider request or authorize resend.
 */
export async function observeTerminalOutcome(input: ObserveTerminalOutcomeInput): Promise<TerminalObservationResult> {
  const provider = input?.provider;
  let snapshot: Omit<ObserveTerminalOutcomeInput, "provider">;
  let canonical: Terms;
  let expected: SharedConfiguration;
  let id: Bytes32Hex, hash: Bytes32Hex, txHash: Bytes32Hex;
  try {
    snapshot = structuredClone({ expectedConfiguration: input.expectedConfiguration, orderId: input.orderId,
      termsHash: input.termsHash, terms: input.terms, transactionHash: input.transactionHash });
    requireEvidence(typeof provider?.send === "function", "InvalidInput", "Expected read-only RPC interface");
    expected = shared(snapshot.expectedConfiguration.evm.configuration);
    requireEvidence(isDeepStrictEqual(expected, shared(snapshot.expectedConfiguration.solana.configuration)),
      "BindingMismatch", "Trusted shared deployment configurations disagree");
    requireEvidence(snapshot.expectedConfiguration.evm.rpcChainId === "31337", "BindingMismatch", "Trusted RPC chain differs");
    id = hex(snapshot.orderId, 32, "InvalidInput", "orderId") as Bytes32Hex;
    hash = hex(snapshot.termsHash, 32, "InvalidInput", "termsHash") as Bytes32Hex;
    txHash = hex(snapshot.transactionHash, 32, "InvalidInput", "transactionHash") as Bytes32Hex;
    canonical = canonicalTerms(snapshot.terms);
    requireEvidence(asHex(orderId(canonical.identity)) === id && asHex(termsHash(canonical)) === hash,
      "InvalidInput", "Expected identity or terms hash is not canonical");
    requireEvidence(canonical.identity.nonce < U64_MAX && BigInt(asHex(canonical.identity.user)) !== 0n
      && canonical.outcome === 0 && canonical.cashAmount >= 1n && canonical.cashAmount <= U64_MAX / 2n
      && canonical.minimumShares >= 1n, "InvalidInput", "Invalid nonce, user, YES outcome or amount bounds");
    const d = snapshot.terms.identity.domain;
    for (const key of ["sourceDomain", "destinationDomain", "solanaProgram", "settlement"] as const) {
      requireEvidence(d[key].toLowerCase() === expected[key], "BindingMismatch", `Expected terms ${key} differs from deployment`);
    }
    requireEvidence(d.chainId === 31337n && snapshot.terms.market.toLowerCase() === expected.market,
      "BindingMismatch", "Expected chain or market differs from deployment");
  } catch (cause) {
    if (cause instanceof TerminalObservationError) throw cause;
    throw new TerminalObservationError("InvalidInput", "Malformed expected terms or configuration", { cause });
  }
  const deadline = Date.now() + 60_000;
  async function rpc(method: TerminalReadMethod, params: unknown[]): Promise<unknown> {
    const started = Date.now();
    const remaining = deadline - started;
    requireEvidence(remaining > 0, "OverallDeadline", `Overall deadline exceeded before ${method}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([provider.send(method, params), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TerminalObservationError(remaining <= 10_000 ? "OverallDeadline" : "RequestDeadline",
          `Observation deadline exceeded during ${method}`)), Math.min(10_000, remaining));
      })]);
      requireEvidence(Date.now() < deadline, "OverallDeadline", "Overall observation deadline exceeded");
      requireEvidence(Date.now() < started + 10_000, "RequestDeadline", `Request deadline exceeded during ${method}`);
      // RPC fixtures and callers must not be able to mutate evidence after a read.
      return structuredClone(value);
    } catch (cause) {
      if (cause instanceof TerminalObservationError) throw cause;
      throw new TerminalObservationError("RpcFailure", `RPC failed: ${method}`, { cause });
    } finally { clearTimeout(timer); }
  }
  const notConfirmed = (reason: Extract<TerminalObservationResult, { kind: "NotConfirmed" }>["reason"]): TerminalObservationResult => ({ kind: "NotConfirmed", reason });
  requireEvidence(quantity(await rpc("eth_chainId", []), "chain ID") === 31337n, "BindingMismatch", "Actual RPC chain ID differs from 31337");
  function receipt(value: unknown) {
    const r = object(value, "receipt");
    const status = quantity(r.status, "receipt status");
    requireEvidence(status === 0n || status === 1n, "MalformedEvidence", "Invalid receipt status");
    requireEvidence(status === 1n, "FailedTransaction", "Failed EVM transaction is not terminal evidence");
    requireEvidence(hex(r.transactionHash, 32, "MalformedEvidence", "receipt transactionHash") === txHash,
      "BindingMismatch", "Receipt transaction hash differs");
    requireEvidence(address(r.from, "MalformedEvidence", "receipt sender") === expected.evmOperator
      && address(r.to, "MalformedEvidence", "receipt destination") === expected.settlement,
    "BindingMismatch", "Receipt sender or destination differs");
    return { number: quantity(r.blockNumber, "receipt blockNumber"),
      hash: hex(r.blockHash, 32, "MalformedEvidence", "receipt blockHash") as Bytes32Hex,
      index: quantity(r.transactionIndex, "receipt transactionIndex") };
  }
  const initialReceipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (initialReceipt === null) return notConfirmed("MissingReceipt");
  const inclusion = receipt(initialReceipt);
  const transactionValue = await rpc("eth_getTransactionByHash", [txHash]);
  if (transactionValue === null) return notConfirmed("MissingTransaction");
  const tx = object(transactionValue, "transaction");
  requireEvidence(hex(tx.hash, 32, "MalformedEvidence", "transaction hash") === txHash
    && hex(tx.blockHash, 32, "MalformedEvidence", "transaction blockHash") === inclusion.hash
    && quantity(tx.blockNumber, "transaction blockNumber") === inclusion.number
    && quantity(tx.transactionIndex, "transaction transactionIndex") === inclusion.index,
  "BindingMismatch", "Transaction identity or inclusion differs from receipt");
  requireEvidence(address(tx.from, "MalformedEvidence", "transaction sender") === expected.evmOperator
    && address(tx.to, "MalformedEvidence", "transaction destination") === expected.settlement
    && quantity(tx.chainId, "transaction chainId") === 31337n && quantity(tx.value, "transaction value") === 0n,
  "BindingMismatch", "Transaction operator, destination, chain ID or native value differs");
  let method: "execute" | "cancel";
  try {
    requireEvidence(typeof tx.input === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(tx.input), "MalformedEvidence", "Invalid calldata bytes");
    const parsed = abi.parseTransaction({ data: tx.input });
    requireEvidence(parsed !== null, "MalformedEvidence", "Unknown Settlement calldata selector");
    requireEvidence(parsed.name === "execute" || parsed.name === "cancel", "BindingMismatch", "Expected execute or cancel calldata");
    method = parsed.name;
    requireEvidence(abi.encodeFunctionData(method, parsed.args).toLowerCase() === tx.input.toLowerCase()
      && tx.input.toLowerCase() === abi.encodeFunctionData(method, [id, snapshot.terms]).toLowerCase(),
    "BindingMismatch", "Calldata does not bind exactly the expected order and complete terms");
  } catch (cause) {
    if (cause instanceof TerminalObservationError) throw cause;
    throw new TerminalObservationError("MalformedEvidence", "Cannot decode actual Settlement calldata", { cause });
  }
  function block(value: unknown) {
    const b = object(value, "block");
    return { number: quantity(b.number, "block number"), hash: hex(b.hash, 32, "MalformedEvidence", "block hash") as Bytes32Hex };
  }
  const headValue = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (headValue === null) return notConfirmed("CanonicalEvidenceUnavailable");
  const head = block(headValue);
  if (head.number < inclusion.number + 2n) return notConfirmed("InsufficientAdditionalBlocks");
  async function canonicalBlock(wanted: { number: bigint; hash: Bytes32Hex }) {
    const value = await rpc("eth_getBlockByNumber", [toQuantity(wanted.number), false]);
    if (value === null) return "CanonicalEvidenceUnavailable" as const;
    const actual = block(value);
    if (actual.number !== wanted.number || actual.hash !== wanted.hash) return "CanonicalEvidenceChanged" as const;
    return null;
  }
  const initialCanonical = await canonicalBlock(inclusion);
  if (initialCanonical) return notConfirmed(initialCanonical);
  async function read(name: "domain" | "operator" | "orderRecord", at: { hash: Bytes32Hex }) {
    // EIP-1898 pins each call to the identified canonical history, not latest.
    const value = await rpc("eth_call", [{ to: expected.settlement,
      data: abi.encodeFunctionData(name, name === "orderRecord" ? [id] : []) }, { blockHash: at.hash, requireCanonical: true }]);
    try {
      requireEvidence(typeof value === "string", "MalformedEvidence", `${name}: invalid RPC return bytes`);
      const decoded = abi.decodeFunctionResult(name, value);
      requireEvidence(abi.encodeFunctionResult(name, decoded).toLowerCase() === value.toLowerCase(), "MalformedEvidence", `${name}: noncanonical ABI result`);
      return decoded[0];
    } catch (cause) {
      if (cause instanceof TerminalObservationError) throw cause;
      throw new TerminalObservationError("MalformedEvidence", `Cannot decode Settlement ${name}`, { cause });
    }
  }
  async function terminal(at: { hash: Bytes32Hex }) {
    const domain = await read("domain", at);
    requireEvidence(abi.encodeFunctionResult("domain", [domain]).toLowerCase()
      === abi.encodeFunctionResult("domain", [snapshot.terms.identity.domain]).toLowerCase(), "BindingMismatch", "Actual Settlement domain differs");
    requireEvidence(address(await read("operator", at), "MalformedEvidence", "Settlement operator") === expected.evmOperator,
      "BindingMismatch", "Actual Settlement operator differs");
    const record = await read("orderRecord", at);
    requireEvidence(record.status === 1n || record.status === 2n, "RecordMismatch", "Storage is not terminal Filled or Cancelled");
    requireEvidence(abi.encodeFunctionData("execute", [id, record.terms]).toLowerCase()
      === abi.encodeFunctionData("execute", [id, snapshot.terms]).toLowerCase()
      && record.termsHash.toLowerCase() === hash, "RecordMismatch", "Stored identity, terms or hash differs");
    const terminal = record.status === 1n ? 1 : 2;
    const filledQuantity: bigint = record.filledQuantity;
    requireEvidence(terminal === 1 ? filledQuantity === canonical.cashAmount * 2n && filledQuantity >= canonical.minimumShares
      : filledQuantity === 0n, "RecordMismatch", "Stored terminal quantity violates full-fill or cancellation policy");
    requireEvidence(method !== "execute" || terminal === 1, "RecordMismatch", "Successful execute cannot return Cancelled");
    const content = { termsHash: hash, terminal, filledQuantity } as const;
    const canonicalHash = asHex(receiptHash({ ...content, termsHash: Buffer.from(hash.slice(2), "hex") }));
    requireEvidence(record.receiptHash.toLowerCase() === canonicalHash, "RecordMismatch", "Stored receipt hash differs from canonical SHA-256");
    return { receipt: content, receiptHash: canonicalHash };
  }
  const first = await terminal(inclusion);
  const last = await terminal(head);
  requireEvidence(isDeepStrictEqual(first, last), "RecordMismatch", "Inclusion and observation-head terminal records contradict permanence");
  const recheckedReceipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (recheckedReceipt === null) return notConfirmed("CanonicalEvidenceUnavailable");
  receipt(recheckedReceipt);
  if (!isDeepStrictEqual(initialReceipt, recheckedReceipt)) return notConfirmed("CanonicalEvidenceChanged");
  for (const wanted of [inclusion, head]) {
    const changed = await canonicalBlock(wanted);
    if (changed) return notConfirmed(changed);
  }
  return { kind: "Confirmed", orderId: id, termsHash: hash, terms: snapshot.terms, ...first, transactionHash: txHash,
    inclusion: { number: inclusion.number, hash: inclusion.hash }, observationHead: head, additionalBlocks: head.number - inclusion.number };
}
