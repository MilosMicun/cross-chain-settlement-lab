import { readFile } from "node:fs/promises";
import { AnchorProvider, Program, Wallet } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { SettlementLab } from "../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "./evm-deployment.ts";
const { buildInitializeArgs } = await import(new URL("./solana-configuration.ts", import.meta.url).href) as typeof import("./solana-configuration.ts");

export type SolanaDeploymentInput = {
  readonly connection: Connection;
  readonly initializer: Keypair;
  readonly evmManifest: EvmDeploymentManifest;
  readonly programId: PublicKey;
  readonly operator: PublicKey;
  readonly executor: PublicKey;
  readonly cashMint: Keypair;
  readonly yesMint: Keypair;
};

export type SolanaSetupReceipt = { readonly signature: string; readonly finalizedSlot: number };

/** Public values only. EVM bindings describe a prior deployment, not live agreement. */
export type SolanaDeploymentManifest = {
  readonly schemaVersion: 1;
  readonly programId: string;
  readonly programData: string;
  readonly roles: { readonly initializer: string; readonly operator: string; readonly executor: string };
  readonly mints: { readonly cash: string; readonly yes: string; readonly decimals: 6;
    readonly cashAuthority: string; readonly yesAuthority: string; readonly freezeAuthority: null };
  readonly accounts: { readonly config: string; readonly accounting: string;
    readonly yesMintAuthority: string; readonly executorCashAta: string;
    readonly tokenProgram: string; readonly associatedTokenProgram: string; readonly systemProgram: string };
  readonly bumps: { readonly config: number; readonly accounting: number; readonly yesMintAuthority: number };
  readonly deployment: Pick<EvmDeploymentManifest, "chainId" | "sourceDomain" | "destinationDomain"
    | "solanaProgram" | "market" | "outcome" | "tokenDecimals" | "roles" | "contracts">;
  readonly transactions: Readonly<Record<"cashMint" | "yesMint" | "executorCashAta" | "initialize", SolanaSetupReceipt>>;
};

// Bound each RPC as well as the overall transaction finalization wait. The caller
// retains Connection/process ownership; a timeout cannot undo a submitted transaction.
async function bounded<T>(operation: Promise<T>, timeout = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Solana setup RPC deadline exceeded")), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Initialize an already loaded local program. No credentials, files, deployment,
 * authority removal, or cleanup are created here. Four separately finalized setup
 * transactions are NOT atomic as a group; only initialize creates Config and
 * Accounting atomically. Failures propagate and may leave earlier token setup.
 */
export async function initializeSolanaFixture(input: SolanaDeploymentInput): Promise<SolanaDeploymentManifest> {
  const { connection, initializer, programId, operator, executor, cashMint, yesMint } = input;
  const evm = structuredClone(input.evmManifest);
  const args = buildInitializeArgs(evm, programId, operator, executor);
  const expectedProgram = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
  if (!programId.equals(expectedProgram)) throw new Error("The repository program identity is required");
  if (evm.chainId !== "31337") throw new Error("The fixture requires local chain ID 31337");
  if (![initializer, cashMint, yesMint].every((key) => key instanceof Keypair)) {
    throw new Error("Initializer and both mint identities must be supplied Keypairs");
  }
  if (cashMint.publicKey.equals(yesMint.publicKey)) throw new Error("Supplied mint identities must be distinct");

  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
  const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
  const executorCashAta = getAssociatedTokenAddressSync(cashMint.publicKey, executor, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const infos = await bounded(connection.getMultipleAccountsInfo(
    [programId, programData, config, accounting, cashMint.publicKey, yesMint.publicKey, executorCashAta], "finalized",
  ));
  const [executable, data, existingConfig, existingAccounting, existingCash, existingYes, existingAta] = infos;
  if (existingConfig || existingAccounting) throw new Error("Existing Config or Accounting: refusing repeated setup");
  if (!executable?.executable || !executable.owner.equals(loader) || executable.data.length !== 36
      || executable.data.readUInt32LE(0) !== 2
      || !new PublicKey(executable.data.subarray(4, 36)).equals(programData)) {
    throw new Error("Expected executable program and canonical linked ProgramData");
  }
  if (!data || data.executable || !data.owner.equals(loader) || data.data.length < 45
      || data.data.readUInt32LE(0) !== 3) throw new Error("Invalid linked ProgramData");
  if (data.data[12] !== 1 || !new PublicKey(data.data.subarray(13, 45)).equals(initializer.publicKey)) {
    throw new Error("Initializer must match the current upgrade authority");
  }
  if (existingCash || existingYes || existingAta) throw new Error("Supplied mint or executor ATA already exists");

  const idl = JSON.parse(await readFile(new URL("../../solana/target/idl/settlement_lab.json", import.meta.url), "utf8")) as SettlementLab;
  const program = new Program<SettlementLab>(idl, new AnchorProvider(connection, new Wallet(initializer), { commitment: "finalized" }));
  if (!program.programId.equals(programId)) throw new Error("Generated IDL program identity mismatch");
  const initialize = await program.methods.initialize(args).accountsStrict({
    initializer: initializer.publicKey, program: programId, programData, config, accounting,
    cashMint: cashMint.publicKey, yesMint: yesMint.publicKey, executorCashAta,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
  let latestSlot = 0;
  async function submit(instructions: TransactionInstruction[], extraSigners: Keypair[] = []): Promise<SolanaSetupReceipt> {
    const deadline = Date.now() + 90_000;
    const withinDeadline = <T>(operation: Promise<T>) => bounded(operation, Math.max(1, Math.min(15_000, deadline - Date.now())));
    const block = await withinDeadline(connection.getLatestBlockhash("finalized"));
    const transaction = new Transaction({ ...block, feePayer: initializer.publicKey }).add(...instructions);
    transaction.sign(initializer, ...extraSigners);
    const signature = await withinDeadline(connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "finalized", maxRetries: 5 }));
    while (Date.now() < deadline) {
      const status = (await withinDeadline(connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
      if (status?.confirmationStatus === "finalized") {
        if (status.err !== null) throw new Error(`Finalized setup transaction failed: ${signature}: ${JSON.stringify(status.err)}`);
        const receipt = await withinDeadline(connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
        if (!receipt?.meta || receipt.meta.err !== null || receipt.slot !== status.slot) {
          throw new Error(`Missing or inconsistent finalized setup receipt: ${signature}`);
        }
        latestSlot = Math.max(latestSlot, receipt.slot);
        return { signature, finalizedSlot: receipt.slot };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Setup finalization deadline exceeded: ${signature}`);
  }
  const rent = await bounded(connection.getMinimumBalanceForRentExemption(MINT_SIZE, "finalized"));
  async function mint(key: Keypair, authority: PublicKey) {
    return submit([
      SystemProgram.createAccount({ fromPubkey: initializer.publicKey, newAccountPubkey: key.publicKey,
        lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMintInstruction(key.publicKey, 6, authority, null, TOKEN_PROGRAM_ID),
    ], [key]);
  }
  const cashReceipt = await mint(cashMint, initializer.publicKey);
  const yesReceipt = await mint(yesMint, yesAuthority);
  const ataReceipt = await submit([createAssociatedTokenAccountInstruction(
    initializer.publicKey, executorCashAta, executor, cashMint.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  )]);
  // Recheck permanent records immediately before initialize. A competing setup
  // still causes an on-chain rejection; earlier token transactions are not undone.
  const records = await bounded(connection.getMultipleAccountsInfo([config, accounting], { commitment: "finalized", minContextSlot: latestSlot }));
  if (records.some((record) => record !== null)) throw new Error("Existing Config or Accounting before initialize");
  const initializeReceipt = await submit([initialize]);
  return {
    schemaVersion: 1, programId: programId.toBase58(), programData: programData.toBase58(),
    roles: { initializer: initializer.publicKey.toBase58(), operator: operator.toBase58(), executor: executor.toBase58() },
    mints: { cash: cashMint.publicKey.toBase58(), yes: yesMint.publicKey.toBase58(), decimals: 6,
      cashAuthority: initializer.publicKey.toBase58(), yesAuthority: yesAuthority.toBase58(), freezeAuthority: null },
    accounts: { config: config.toBase58(), accounting: accounting.toBase58(), yesMintAuthority: yesAuthority.toBase58(),
      executorCashAta: executorCashAta.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), systemProgram: SystemProgram.programId.toBase58() },
    bumps: { config: configBump, accounting: accountingBump, yesMintAuthority: yesBump },
    deployment: { chainId: evm.chainId, sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
      solanaProgram: evm.solanaProgram, market: evm.market, outcome: evm.outcome, tokenDecimals: evm.tokenDecimals,
      roles: evm.roles, contracts: evm.contracts },
    transactions: { cashMint: cashReceipt, yesMint: yesReceipt, executorCashAta: ataReceipt, initialize: initializeReceipt },
  };
}
