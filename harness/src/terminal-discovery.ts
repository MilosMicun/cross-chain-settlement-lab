import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Interface, getAddress, toQuantity } from "ethers";
import type { LiveConfigurationObservation, SharedConfiguration } from "./live-configuration.ts";
import type { Bytes32Hex, EvmTerms } from "./source-order.ts";
import type { Terms } from "./protocol-encoding.ts";
import type { TerminalReadMethod, TerminalObservationResult } from "./terminal-observation.ts";
const { orderId, termsHash, receiptHash } = await import(new URL("./protocol-encoding.ts", import.meta.url).href) as typeof import("./protocol-encoding.ts");
const { observeTerminalOutcome, TerminalObservationError } = await import(new URL("./terminal-observation.ts", import.meta.url).href) as typeof import("./terminal-observation.ts");

export type TerminalDiscoveryRpc = {
  send(method: TerminalReadMethod | "eth_getLogs", params: unknown[]): Promise<unknown>;
};
export type DiscoverTerminalOutcomeInput = {
  readonly provider: TerminalDiscoveryRpc;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly orderId: Bytes32Hex;
  readonly termsHash: Bytes32Hex;
  readonly terms: EvmTerms;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
};
export type TerminalDiscoveryResult = {
  kind: "NotFound";
  searched: { fromBlock: bigint; toBlock: bigint };
} | {
  kind: "Observed";
  transactionHash: Bytes32Hex;
  observation: TerminalObservationResult;
};
export type TerminalDiscoveryErrorCode = "InvalidInput" | "InvalidRange" | "BindingMismatch"
  | "MalformedEvidence" | "AmbiguousCandidates" | "HistoryUnavailable" | "HistoryChanged"
  | "RpcFailure" | "RequestDeadline" | "OverallDeadline";
export class TerminalDiscoveryError extends Error {
  readonly code: TerminalDiscoveryErrorCode;
  constructor(code: TerminalDiscoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalDiscoveryError";
    this.code = code;
  }
}

const abi = new Interface(JSON.parse(readFileSync(new URL("../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8")).abi);
const event = abi.getEvent("TerminalRecorded")!;
const U64_MAX = (1n << 64n) - 1n;
const U256_LIMIT = 1n << 256n;
function requireEvidence(ok: boolean, code: TerminalDiscoveryErrorCode, message: string): asserts ok {
  if (!ok) throw new TerminalDiscoveryError(code, message);
}
function hex(value: unknown, width: number, code: TerminalDiscoveryErrorCode, label: string): string {
  requireEvidence(typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${width * 2}}$`).test(value), code, `${label}: expected ${width} bytes`);
  return value.toLowerCase();
}
function address(value: unknown, code: TerminalDiscoveryErrorCode, label: string): string {
  const result = hex(value, 20, code, label);
  try { getAddress(value as string); } catch (cause) {
    throw new TerminalDiscoveryError(code, `${label}: invalid address checksum`, { cause });
  }
  return result;
}
function nonzeroHash(value: unknown, label: string): Bytes32Hex {
  const result = hex(value, 32, "MalformedEvidence", label) as Bytes32Hex;
  requireEvidence(BigInt(result) !== 0n, "MalformedEvidence", `${label}: zero hash`);
  return result;
}
function quantity(value: unknown, label: string): bigint {
  requireEvidence(typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value), "MalformedEvidence", `${label}: expected canonical RPC quantity`);
  const result = BigInt(value);
  requireEvidence(result < U256_LIMIT, "MalformedEvidence", `${label}: exceeds uint256`);
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

/** One bounded reconstruction under trusted RPC/operator assumptions, using
 * the existing observer's local N+2 policy. Observed may be NotConfirmed.
 * NotFound is only a bounded negative search, not proof of absence, Unseen,
 * failed broadcast, refund eligibility or permission to resend. No discovery
 * result authorizes an action. Live process restart recovery is outside scope.
 * No writes, retries, polling, mining or persistence. A timeout does not cancel
 * an underlying read. All reads, including the observer's, share this attempt's
 * 60-second budget and have individual 10-second deadlines.
 */
export async function discoverTerminalOutcome(input: DiscoverTerminalOutcomeInput): Promise<TerminalDiscoveryResult> {
  const deadline = Date.now() + 60_000;
  let snapshot: Omit<DiscoverTerminalOutcomeInput, "provider">;
  let send: TerminalDiscoveryRpc["send"];
  let expected: SharedConfiguration;
  let id: Bytes32Hex, hash: Bytes32Hex;
  try {
    const provider = input?.provider;
    const read = provider?.send;
    requireEvidence(typeof read === "function", "InvalidInput", "Expected read-only RPC interface");
    send = read.bind(provider);
    snapshot = structuredClone({ expectedConfiguration: input.expectedConfiguration, orderId: input.orderId,
      termsHash: input.termsHash, terms: input.terms, fromBlock: input.fromBlock, toBlock: input.toBlock });
    requireEvidence(typeof snapshot.fromBlock === "bigint" && typeof snapshot.toBlock === "bigint"
      && snapshot.fromBlock >= 0n && snapshot.fromBlock <= snapshot.toBlock && snapshot.toBlock < U256_LIMIT
      && snapshot.toBlock - snapshot.fromBlock + 1n <= 2_048n, "InvalidRange", "Expected 1 to 2048 explicit uint256 blocks");
    expected = shared(snapshot.expectedConfiguration.evm.configuration);
    requireEvidence(isDeepStrictEqual(expected, shared(snapshot.expectedConfiguration.solana.configuration)),
      "BindingMismatch", "Trusted shared deployment configurations disagree");
    requireEvidence(snapshot.expectedConfiguration.evm.rpcChainId === "31337", "BindingMismatch", "Trusted RPC chain differs");
    id = hex(snapshot.orderId, 32, "InvalidInput", "orderId") as Bytes32Hex;
    hash = hex(snapshot.termsHash, 32, "InvalidInput", "termsHash") as Bytes32Hex;
    const canonical = canonicalTerms(snapshot.terms);
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
    if (cause instanceof TerminalDiscoveryError) throw cause;
    throw new TerminalDiscoveryError("InvalidInput", "Malformed expected terms or configuration", { cause });
  }
  function withinDeadline() {
    requireEvidence(Date.now() < deadline, "OverallDeadline", "Overall discovery deadline exceeded");
  }
  async function rpc(method: TerminalReadMethod | "eth_getLogs", params: unknown[]): Promise<unknown> {
    const started = Date.now();
    const remaining = deadline - started;
    requireEvidence(remaining > 0, "OverallDeadline", `Overall deadline exceeded before ${method}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TerminalDiscoveryError(remaining <= 10_000 ? "OverallDeadline" : "RequestDeadline",
          `Discovery deadline exceeded during ${method}`)), Math.min(10_000, remaining));
      });
      const value = await Promise.race([Promise.resolve(send(method, structuredClone(params))).then((value) => structuredClone(value)), timeout]);
      withinDeadline();
      requireEvidence(Date.now() < started + 10_000, "RequestDeadline", `Request deadline exceeded during ${method}`);
      return value;
    } catch (cause) {
      if (cause instanceof TerminalDiscoveryError) throw cause;
      throw new TerminalDiscoveryError("RpcFailure", `RPC failed: ${method}`, { cause });
    } finally { clearTimeout(timer); }
  }
  function anchor(value: unknown) {
    requireEvidence(value !== null, "HistoryUnavailable", "Search range anchor is unavailable");
    const b = object(value, "search range anchor");
    const number = quantity(b.number, "anchor number");
    requireEvidence(number === snapshot.toBlock, "HistoryChanged", "Search anchor returned a different block number");
    return { number, hash: nonzeroHash(b.hash, "anchor hash") };
  }
  requireEvidence(quantity(await rpc("eth_chainId", []), "chain ID") === 31337n, "BindingMismatch", "Actual RPC chain ID differs from 31337");
  const rangeAnchor = anchor(await rpc("eth_getBlockByNumber", [toQuantity(snapshot.toBlock), false]));
  async function recheckAnchor() {
    const current = anchor(await rpc("eth_getBlockByNumber", [toQuantity(snapshot.toBlock), false]));
    requireEvidence(isDeepStrictEqual(current, rangeAnchor), "HistoryChanged", "Search range anchor changed");
    withinDeadline();
  }
  function candidate(value: unknown) {
    const log = object(value, "terminal log");
    requireEvidence(address(log.address, "MalformedEvidence", "log emitter") === expected.settlement,
      "BindingMismatch", "Terminal event emitter differs");
    requireEvidence(Array.isArray(log.topics) && log.topics.length === 3, "MalformedEvidence", "Terminal event requires exactly three topics");
    const topics = Array.from(log.topics, (topic) => hex(topic, 32, "MalformedEvidence", "event topic"));
    requireEvidence(topics[0] === event.topicHash, "MalformedEvidence", "Wrong TerminalRecorded signature");
    requireEvidence(topics[1] === id && topics[2] === hash, "BindingMismatch", "Terminal event order or terms differs");
    requireEvidence(typeof log.data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(log.data), "MalformedEvidence", "Invalid event data bytes");
    let decoded;
    try {
      decoded = abi.decodeEventLog(event, log.data, topics);
      const encoded = abi.encodeEventLog(event, decoded);
      requireEvidence(encoded.data === log.data.toLowerCase() && isDeepStrictEqual(encoded.topics, topics),
        "MalformedEvidence", "Noncanonical TerminalRecorded ABI encoding");
    } catch (cause) {
      if (cause instanceof TerminalDiscoveryError) throw cause;
      throw new TerminalDiscoveryError("MalformedEvidence", "Cannot decode TerminalRecorded", { cause });
    }
    requireEvidence(decoded.terminal === 1n || decoded.terminal === 2n, "MalformedEvidence", "Invalid terminal outcome");
    const terminal = decoded.terminal === 1n ? 1 : 2;
    const filledQuantity: bigint = decoded.filledQuantity;
    requireEvidence(terminal === 1 ? filledQuantity === 2n * snapshot.terms.cashAmount && filledQuantity >= snapshot.terms.minimumShares
      : filledQuantity === 0n, "MalformedEvidence", "Event quantity violates full-fill or cancellation policy");
    const canonicalHash = asHex(receiptHash({ termsHash: Buffer.from(hash.slice(2), "hex"), terminal, filledQuantity }));
    requireEvidence(decoded.receiptHash.toLowerCase() === canonicalHash, "MalformedEvidence", "Event receipt hash is not canonical");
    const blockNumber = quantity(log.blockNumber, "log blockNumber");
    requireEvidence(blockNumber >= snapshot.fromBlock && blockNumber <= snapshot.toBlock, "MalformedEvidence", "Log is outside the bounded range");
    requireEvidence(log.removed === false, "MalformedEvidence", "Log is removed or lacks an explicit false removed flag");
    return { address: expected.settlement, topics, data: log.data.toLowerCase(), terminal, filledQuantity, receiptHash: canonicalHash,
      transactionHash: nonzeroHash(log.transactionHash, "log transactionHash"), blockHash: nonzeroHash(log.blockHash, "log blockHash"),
      blockNumber, transactionIndex: quantity(log.transactionIndex, "log transactionIndex"), logIndex: quantity(log.logIndex, "log logIndex") };
  }
  const logs = await rpc("eth_getLogs", [{ address: expected.settlement, fromBlock: toQuantity(snapshot.fromBlock),
    toBlock: toQuantity(snapshot.toBlock), topics: [event.topicHash, id] }]);
  requireEvidence(Array.isArray(logs), "MalformedEvidence", "eth_getLogs must return an array");
  // Validate every entry even if the response is also ambiguous.
  const candidates = Array.from(logs, candidate);
  requireEvidence(candidates.length <= 1, "AmbiguousCandidates", "Multiple terminal log entries, including duplicates, are ambiguous");
  if (candidates.length === 0) {
    await recheckAnchor();
    return { kind: "NotFound", searched: { fromBlock: snapshot.fromBlock, toBlock: snapshot.toBlock } };
  }
  const selected = candidates[0];
  const receiptValue = await rpc("eth_getTransactionReceipt", [selected.transactionHash]);
  requireEvidence(receiptValue !== null, "HistoryUnavailable", "Discovered transaction receipt is unavailable");
  const receipt = object(receiptValue, "discovered receipt");
  requireEvidence(quantity(receipt.status, "receipt status") === 1n, "MalformedEvidence", "Discovered transaction must have status 1");
  requireEvidence(nonzeroHash(receipt.transactionHash, "receipt transactionHash") === selected.transactionHash
    && nonzeroHash(receipt.blockHash, "receipt blockHash") === selected.blockHash
    && quantity(receipt.blockNumber, "receipt blockNumber") === selected.blockNumber
    && quantity(receipt.transactionIndex, "receipt transactionIndex") === selected.transactionIndex,
  "BindingMismatch", "Receipt transaction or inclusion metadata differs from candidate");
  requireEvidence(Array.isArray(receipt.logs), "MalformedEvidence", "Receipt logs must be an array");
  let occurrences = 0;
  for (const value of receipt.logs) {
    const log = object(value, "receipt log");
    if (typeof log.address === "string" && log.address.toLowerCase() === expected.settlement
      && Array.isArray(log.topics) && typeof log.topics[0] === "string" && log.topics[0].toLowerCase() === event.topicHash
      && typeof log.topics[1] === "string" && log.topics[1].toLowerCase() === id) {
      requireEvidence(isDeepStrictEqual(candidate(log), selected), "BindingMismatch", "Receipt terminal event differs from candidate");
      occurrences += 1;
    }
  }
  requireEvidence(occurrences === 1, "MalformedEvidence", "Exact candidate event must occur once in receipt logs");
  let observation: TerminalObservationResult;
  try {
    observation = await observeTerminalOutcome({ provider: { send: rpc }, expectedConfiguration: snapshot.expectedConfiguration,
      orderId: id, termsHash: hash, terms: snapshot.terms, transactionHash: selected.transactionHash });
  } catch (cause) {
    // The observer wraps provider failures. Restore this wrapper's typed error;
    // its own validation errors otherwise propagate without reinterpretation.
    if (cause instanceof TerminalObservationError && cause.cause instanceof TerminalDiscoveryError) throw cause.cause;
    throw cause;
  }
  if (observation.kind === "Confirmed") {
    requireEvidence(observation.transactionHash === selected.transactionHash && observation.orderId === id && observation.termsHash === hash
      && observation.inclusion.number === selected.blockNumber && observation.inclusion.hash === selected.blockHash
      && observation.receipt.termsHash === hash && observation.receipt.terminal === selected.terminal
      && observation.receipt.filledQuantity === selected.filledQuantity && observation.receiptHash === selected.receiptHash,
    "BindingMismatch", "Observer inclusion or terminal receipt differs from discovered event");
  }
  await recheckAnchor();
  const result: TerminalDiscoveryResult = structuredClone({ kind: "Observed", transactionHash: selected.transactionHash, observation });
  withinDeadline();
  return result;
}
