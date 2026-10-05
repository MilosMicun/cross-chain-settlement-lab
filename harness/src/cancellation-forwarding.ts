import { readFileSync } from "node:fs";
import { Contract, getAddress, type InterfaceAbi, type JsonRpcProvider, type Signer } from "ethers";
import { PublicKey } from "@solana/web3.js";
import type { LiveConfigurationObservation } from "./live-configuration.ts";
import type { FinalizedCancellationRequest, SourceOrderConnection } from "./source-order.ts";
const { readFinalizedCancellationRequest } = await import(new URL("./source-order.ts", import.meta.url).href) as typeof import("./source-order.ts");

export type ForwardCancellationRequestInput = {
  readonly provider: JsonRpcProvider;
  readonly operator: Signer;
  readonly connection: SourceOrderConnection;
  readonly expectedConfiguration: LiveConfigurationObservation;
  readonly user: PublicKey;
  readonly nonce: bigint;
  readonly minFinalizedSlot: number;
};
export type ForwardCancellationRequestSubmission = {
  sourceRequest: FinalizedCancellationRequest;
  transactionHash: string;
};

const artifact = JSON.parse(readFileSync(new URL("../../evm/out/Settlement.sol/Settlement.json", import.meta.url), "utf8"));
if (!Array.isArray(artifact.abi)) throw new Error("Build the actual Settlement ABI before forwarding");
const abi = artifact.abi as InterfaceAbi;

/** CancelRequested proves observed source intent under the trusted RPC/program
 * model, not destination cancellation. The returned hash proves submission only.
 * Execute may win before cancel; cancel can successfully return existing Filled.
 * Callers must observe the actual terminal result before further action.
 * Errors, missing acknowledgements and timeouts can leave broadcast outcome
 * unknown and never authorize refund or automatic resubmission. No retries,
 * source transactions, receipt waiting or recovery. Each awaited operation is
 * bounded to 10 seconds within a 60-second overall deadline; underlying provider
 * requests are not cancelled by these deadlines.
 */
export async function forwardCancellationRequest(input: ForwardCancellationRequestInput): Promise<ForwardCancellationRequestSubmission> {
  const { provider, operator, connection, nonce, minFinalizedSlot } = input;
  if (operator.provider !== provider) throw new Error("Operator signer must use the supplied provider");
  const expectedConfiguration = structuredClone(input.expectedConfiguration);
  const user = new PublicKey(input.user.toBytes());
  const expected = expectedConfiguration.evm.configuration;
  const deadline = Date.now() + 60_000;
  async function bounded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const remaining = Math.min(10_000, deadline - started);
    if (remaining <= 0) throw new Error(`Forwarding deadline exceeded: ${label}; broadcast outcome may be unknown`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Forwarding timeout: ${label}; broadcast outcome may be unknown`)), remaining);
      })]);
      if (Date.now() >= started + remaining) {
        throw new Error(`Forwarding deadline exceeded: ${label}; broadcast outcome may be unknown`);
      }
      return result;
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
  const sourceRequest = await bounded("finalized source cancellation request", () => readFinalizedCancellationRequest({
    connection, expectedConfiguration, user, nonce, minFinalizedSlot,
  }));
  const wanted = sourceRequest.terms.identity.domain;
  if (wanted.sourceDomain.toLowerCase() !== expected.sourceDomain.toLowerCase()
    || wanted.destinationDomain.toLowerCase() !== expected.destinationDomain.toLowerCase()
    || wanted.solanaProgram.toLowerCase() !== expected.solanaProgram.toLowerCase()
    || wanted.chainId !== BigInt(expected.chainId) || wanted.chainId !== 31337n
    || getAddress(wanted.settlement) !== getAddress(expected.settlement)
    || sourceRequest.terms.market.toLowerCase() !== expected.market.toLowerCase()) {
    throw new Error("Validated source destination differs from the verified EVM configuration");
  }
  const settlement = new Contract(wanted.settlement, abi, operator);
  const domain = await bounded("Settlement domain", () => settlement.getFunction("domain").staticCall());
  if (domain.sourceDomain.toLowerCase() !== wanted.sourceDomain.toLowerCase()
    || domain.destinationDomain.toLowerCase() !== wanted.destinationDomain.toLowerCase()
    || domain.solanaProgram.toLowerCase() !== wanted.solanaProgram.toLowerCase()
    || domain.chainId !== wanted.chainId || getAddress(domain.settlement) !== getAddress(wanted.settlement)) {
    throw new Error("Actual Settlement domain differs from the validated source cancellation request");
  }
  const actualOperator = await bounded("Settlement operator", () => settlement.getFunction("operator").staticCall());
  if (getAddress(actualOperator) !== signerAddress || getAddress(actualOperator) !== getAddress(expected.evmOperator)) {
    throw new Error("Actual Settlement operator differs from signer or verified configuration");
  }
  const transaction = await bounded("cancel submission", () => settlement.getFunction("cancel").send(sourceRequest.orderId, sourceRequest.terms));
  return { sourceRequest, transactionHash: transaction.hash };
}
