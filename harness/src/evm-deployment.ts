import { readFile } from "node:fs/promises";
import {
  Contract, ContractFactory, getAddress, hexlify, ZeroAddress,
  type InterfaceAbi, type JsonRpcProvider, type Signer, type TransactionResponse,
} from "ethers";

export type EvmDeploymentInput = {
  readonly provider: JsonRpcProvider;
  readonly deployer: Signer;
  readonly operator: Signer;
  readonly executor: Signer;
  readonly sourceDomain: Uint8Array;
  readonly destinationDomain: Uint8Array;
  readonly solanaProgram: Uint8Array;
  readonly market: Uint8Array;
};

type SetupStep = "usdDeployment" | "yesDeployment" | "venueDeployment" | "settlementDeployment"
  | "executorFunding" | "venueFunding" | "executorApproval";

export type EvmSetupReceipt = {
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
};

/** Public setup output only; credentials and live client objects never belong here. */
export type EvmDeploymentManifest = {
  readonly schemaVersion: 1;
  readonly chainId: string;
  readonly sourceDomain: string;
  readonly destinationDomain: string;
  readonly solanaProgram: string;
  readonly market: string;
  readonly outcome: 0;
  readonly tokenDecimals: 6;
  readonly roles: { readonly deployer: string; readonly operator: string; readonly executor: string };
  readonly contracts: { readonly usd: string; readonly yes: string; readonly venue: string; readonly settlement: string };
  readonly funding: { readonly executorUsd: string; readonly venueYes: string; readonly executorAllowance: string };
  readonly transactions: Readonly<Record<SetupStep, EvmSetupReceipt>>;
};

const EXECUTOR_USD = 100_000_000n;
const VENUE_YES = 200_000_000n;

function nonzeroBytes32(value: Uint8Array, field: string): string {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${field} must contain exactly 32 raw bytes`);
  }
  if (!value.some((byte) => byte !== 0)) throw new Error(`${field} must be nonzero`);
  // Snapshot caller-owned bytes before any asynchronous operation.
  return hexlify(value);
}

async function artifact(relativePath: string): Promise<{ abi: InterfaceAbi; bytecode: string }> {
  const parsed = JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
  if (!Array.isArray(parsed.abi) || typeof parsed.bytecode?.object !== "string"
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(parsed.bytecode.object)) {
    throw new Error(`Missing ABI or creation bytecode in ${relativePath}; build Foundry artifacts first`);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

async function successfulReceipt(transaction: TransactionResponse): Promise<EvmSetupReceipt> {
  const receipt = await transaction.wait(1, 60_000);
  if (!receipt || receipt.status !== 1) throw new Error(`Setup transaction failed: ${transaction.hash}`);
  return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

/** Deploy a new local mock fixture. Provider ownership and persistence belong to the caller.
 * Status-1 receipts establish local setup success, not the later cross-chain finality policy.
 * Funding is executor liquidity and venue inventory, never a user deposit or bridge transfer.
 * Domains identify this deployment and must remain stable throughout its run.
 */
export async function deployEvmFixture(input: EvmDeploymentInput): Promise<EvmDeploymentManifest> {
  const { provider, deployer, operator, executor } = input;
  const sourceDomain = nonzeroBytes32(input.sourceDomain, "sourceDomain");
  const destinationDomain = nonzeroBytes32(input.destinationDomain, "destinationDomain");
  const solanaProgram = nonzeroBytes32(input.solanaProgram, "solanaProgram");
  const market = nonzeroBytes32(input.market, "market");
  if (sourceDomain === destinationDomain) throw new Error("Deployment domains must be distinct");
  for (const signer of [deployer, operator, executor]) {
    if (signer.provider !== provider) throw new Error("Every signer must use the supplied provider");
  }
  const [deployerAddress, operatorAddress, executorAddress] = await Promise.all(
    [deployer, operator, executor].map(async (signer) => getAddress(await signer.getAddress())),
  );
  const addresses = [deployerAddress, operatorAddress, executorAddress];
  if (addresses.includes(ZeroAddress) || new Set(addresses).size !== 3) {
    throw new Error("Deployer, operator and executor must be distinct nonzero role addresses");
  }
  // Read the actual RPC value, including when the caller configured a static network.
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 31337n) throw new Error("The fixture requires actual RPC chain ID 31337");
  const tokenArtifact = await artifact("../../evm/out/MockERC20.sol/MockERC20.json");
  const venueArtifact = await artifact("../../evm/out/MockVenue.sol/MockVenue.json");
  const settlementArtifact = await artifact("../../evm/out/Settlement.sol/Settlement.json");

  async function deploy(compiled: typeof tokenArtifact, args: readonly unknown[]) {
    const contract = await new ContractFactory(compiled.abi, compiled.bytecode, deployer).deploy(...args);
    const transaction = contract.deploymentTransaction();
    if (!transaction) throw new Error("Missing deployment transaction");
    const receipt = await successfulReceipt(transaction);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    if (await provider.getCode(address) === "0x") throw new Error(`Empty deployed code at ${address}`);
    return { address, receipt };
  }

  const usd = await deploy(tokenArtifact, ["Mock USD", "mUSD", deployerAddress]);
  const yes = await deploy(tokenArtifact, ["Mock YES", "mYES", deployerAddress]);
  const venue = await deploy(venueArtifact, [usd.address, yes.address, market]);
  const settlement = await deploy(settlementArtifact, [{
    sourceDomain, destinationDomain, solanaProgram, operator: operatorAddress, executor: executorAddress,
    usdToken: usd.address, yesToken: yes.address, venue: venue.address, market,
  }]);
  const usdToken = new Contract(usd.address, tokenArtifact.abi, deployer);
  const yesToken = new Contract(yes.address, tokenArtifact.abi, deployer);
  const executorFunding = await successfulReceipt(await usdToken.getFunction("mint")(executorAddress, EXECUTOR_USD));
  const venueFunding = await successfulReceipt(await yesToken.getFunction("mint")(venue.address, VENUE_YES));
  const executorApproval = await successfulReceipt(
    await usdToken.connect(executor).getFunction("approve")(settlement.address, EXECUTOR_USD),
  );
  return {
    schemaVersion: 1, chainId: chainId.toString(), sourceDomain, destinationDomain, solanaProgram, market,
    outcome: 0, tokenDecimals: 6,
    roles: { deployer: deployerAddress, operator: operatorAddress, executor: executorAddress },
    contracts: { usd: usd.address, yes: yes.address, venue: venue.address, settlement: settlement.address },
    funding: { executorUsd: EXECUTOR_USD.toString(), venueYes: VENUE_YES.toString(), executorAllowance: EXECUTOR_USD.toString() },
    transactions: {
      usdDeployment: usd.receipt, yesDeployment: yes.receipt, venueDeployment: venue.receipt,
      settlementDeployment: settlement.receipt, executorFunding, venueFunding, executorApproval,
    },
  };
}
