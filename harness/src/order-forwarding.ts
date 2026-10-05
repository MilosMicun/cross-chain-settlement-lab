import { readFileSync } from "node:fs";
import { Contract, getAddress, type InterfaceAbi, type JsonRpcProvider, type Signer } from "ethers";
import { PublicKey } from "@solana/web3.js";
import type { LiveConfigurationObservation } from "./live-configuration.ts";
import type { FinalizedPendingOrder, SourceOrderConnection } from "./source-order.ts";
const { readFinalizedPendingOrder } = await import(new URL("./source-order.ts", import.meta.url).href) as typeof import("./source-order.ts");

export type ForwardPendingOrderInput = {
  readonly provider: JsonRpcProvider;
  readonly operator: Signer;
  readonly connection: SourceOrderConnection;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly user: PublicKey;
  readonly nonce: bigint;
  readonly minFinalizedSlot: number;
};
export type ForwardPendingOrderSubmission = {
  sourceOrder: FinalizedPendingOrder;
  transactionHash: string;
};

const artifact = JSON.parse(readFileSync(new URL("../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8"));
if (!Array.isArray(artifact.abi)) throw new Error("Build the actual Settlement ABI before forwarding");
const abi = artifact.abi as InterfaceAbi;

/** One explicit submission under the trusted-operator model; the returned hash
 * proves submission only, never success or finality. A finalized Pending read is
 * not a lock: cancellation can race with submission, and Settlement enforces
 * destination terminal exclusivity. No source transactions or receipt delivery.
 * Each wait is bounded to 10 seconds within a 60-second overall deadline.
 * Errors/timeouts can leave broadcast outcome unknown, including after return
 * of an RPC error. They never establish Unseen or authorize refund/resubmission.
 * No automatic retry; provider ownership and later recovery remain with caller.
 */
export async function forwardPendingOrder(input: ForwardPendingOrderInput): Promise<ForwardPendingOrderSubmission> {
  const { provider, operator, connection, nonce, minFinalizedSlot } = input;
  if (operator.provider !== provider) throw new Error("Operator signer must use the supplied provider");
  const expectedConfiguration = structuredClone(input.expectedConfiguration);
  const user = new PublicKey(input.user.toBytes());
  const expected = expectedConfiguration.evm.configuration;
  const deadline = Date.now() + 60_000;
  async function bounded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const remaining = Math.min(10_000, deadline - Date.now());
    if (remaining <= 0) throw new Error(`Forwarding deadline exceeded: ${label}; broadcast outcome may be unknown`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Forwarding timeout: ${label}; broadcast outcome may be unknown`)), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  const signerAddress = getAddress(await bounded("operator address", () => operator.getAddress()));
  if (signerAddress !== getAddress(expected.evmOperator)
    || signerAddress !== getAddress(expectedConfiguration.solana.configuration.evmOperator)) {
    throw new Error("Operator signer differs from the configured EVM operator");
  }
  if (BigInt(await bounded("actual chain ID", () => provider.send("eth_chainId", []))) !== 31337n) {
    throw new Error("Forwarding requires actual RPC chain ID 31337");
  }
  const sourceOrder = await bounded("finalized source order", () => readFinalizedPendingOrder({
    connection, expectedConfiguration, user, nonce, minFinalizedSlot,
  }));
  const wanted = sourceOrder.terms.identity.domain;
  if (wanted.chainId !== 31337n || getAddress(wanted.settlement) !== getAddress(expected.settlement)) {
    throw new Error("Validated source destination differs from the verified EVM configuration");
  }
  const settlement = new Contract(wanted.settlement, abi, operator);
  const domain = await bounded("Settlement domain", () => settlement.getFunction("domain").staticCall());
  if (domain.sourceDomain.toLowerCase() !== wanted.sourceDomain.toLowerCase()
    || domain.destinationDomain.toLowerCase() !== wanted.destinationDomain.toLowerCase()
    || domain.solanaProgram.toLowerCase() !== wanted.solanaProgram.toLowerCase()
    || domain.chainId !== wanted.chainId || getAddress(domain.settlement) !== getAddress(wanted.settlement)) {
    throw new Error("Actual Settlement domain differs from the validated source order");
  }
  const actualOperator = await bounded("Settlement operator", () => settlement.getFunction("operator").staticCall());
  if (getAddress(actualOperator) !== signerAddress || getAddress(actualOperator) !== getAddress(expected.evmOperator)) {
    throw new Error("Actual Settlement operator differs from signer or verified configuration");
  }
  const transaction = await bounded("execute submission", () => settlement.getFunction("execute").send(sourceOrder.orderId, sourceOrder.terms));
  return { sourceOrder, transactionHash: transaction.hash };
}
