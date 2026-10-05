import { PublicKey } from "@solana/web3.js";
import type { LiveConfigurationObservation } from "./live-configuration.ts";
import type { FinalizedRecoveryOrder, SourceOrderConnection } from "./source-order.ts";
import type { TerminalDiscoveryResult, TerminalDiscoveryRpc } from "./terminal-discovery.ts";
import type { RecoveryPlan } from "./recovery-plan.ts";
const { readFinalizedRecoveryOrder } = await import(new URL("./source-order.ts", import.meta.url).href) as typeof import("./source-order.ts");
const { discoverTerminalOutcome } = await import(new URL("./terminal-discovery.ts", import.meta.url).href) as typeof import("./terminal-discovery.ts");
const { planRecovery } = await import(new URL("./recovery-plan.ts", import.meta.url).href) as typeof import("./recovery-plan.ts");

export type ObserveRecoveryInput = {
  readonly sourceConnection: SourceOrderConnection;
  readonly destinationProvider: TerminalDiscoveryRpc;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly user: PublicKey;
  readonly nonce: bigint;
  readonly minFinalizedSlot: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
};

export type RecoveryObservation = {
  source: FinalizedRecoveryOrder;
  destination: TerminalDiscoveryResult;
  plan: RecoveryPlan;
};

/** One read-only attempt depending on trusted RPC/operator/configuration
 * assumptions. Source and destination reads are sequential, not an atomic
 * cross-chain snapshot. The plan is a proposed action, not a lock or proof of
 * delivery. A future executor must validate appropriate fresh evidence and
 * reconcile on-chain results. Neither missing confirmation nor a timeout permits
 * resend or refund; NotFound never means Unseen. Local N+2 is not production
 * finality. Existing source and discovery budgets apply sequentially, without
 * retries, polling or a new deadline. This composition does not change delivery
 * builder types or implement restart execution, signing, submission or storage.
 */
export async function observeRecovery(input: ObserveRecoveryInput): Promise<RecoveryObservation> {
  const { sourceConnection, destinationProvider, user: callerUser } = input;
  // Let the source reader reject invalid users with its existing typed error.
  const user = callerUser instanceof PublicKey ? new PublicKey(callerUser.toBytes()) : callerUser;
  const { expectedConfiguration, nonce, minFinalizedSlot, fromBlock, toBlock } = structuredClone({
    expectedConfiguration: input.expectedConfiguration, nonce: input.nonce,
    minFinalizedSlot: input.minFinalizedSlot, fromBlock: input.fromBlock, toBlock: input.toBlock,
  });
  const source = await readFinalizedRecoveryOrder({
    connection: sourceConnection, expectedConfiguration, user, nonce, minFinalizedSlot,
  });
  const destination = await discoverTerminalOutcome({
    provider: destinationProvider, expectedConfiguration, fromBlock, toBlock,
    orderId: source.orderId, termsHash: source.termsHash, terms: source.terms,
  });
  const plan = planRecovery({ source, destination: destination.kind === "Observed" ? destination.observation : null });
  return { source, destination, plan };
}
