import { createHash } from "node:crypto";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
import { Contract, getAddress, hexlify, toQuantity, type JsonRpcProvider } from "ethers";
import type { EvmDeploymentManifest } from "./evm-deployment.ts";
import type { SolanaDeploymentManifest } from "./solana-deployment.ts";
const { buildInitializeArgs } = await import(new URL("./solana-configuration.ts", import.meta.url).href) as typeof import("./solana-configuration.ts");

export type LiveConfigurationInput = {
  readonly provider: JsonRpcProvider;
  readonly connection: Connection;
  readonly evmManifest: EvmDeploymentManifest;
  readonly solanaManifest: SolanaDeploymentManifest;
  readonly minFinalizedSlot: number;
};

export type SharedConfiguration = {
  sourceDomain: string; destinationDomain: string; solanaProgram: string; chainId: string;
  settlement: string; venue: string; cashToken: string; yesToken: string;
  evmOperator: string; evmExecutor: string; market: string;
};

export type LiveConfigurationObservation = {
  scope: string;
  evm: { blockNumber: number; blockHash: string; rpcChainId: string; configuration: SharedConfiguration;
    venue: { cashToken: string; yesToken: string; market: string };
    tokenDecimals: { cash: string; yes: string }; codeBytes: Record<string, number> };
  solana: { contextSlot: number; minContextSlot: number; commitment: "finalized"; configuration: SharedConfiguration;
    config: { address: string; owner: string; dataHex: string; version: number; outcome: number; bump: number;
      yesAuthorityBump: number; operator: string; executor: string; cashMint: string; yesMint: string;
      executorCashAta: string; yesAuthority: string; tokenProgram: string; associatedTokenProgram: string; systemProgram: string };
    accounting: { address: string; owner: string; config: string; bump: number; counters: string[] };
    mints: { cash: MintObservation; yes: MintObservation };
    executorCashAta: { address: string; owner: string; mint: string; amount: string };
    program: { address: string; owner: string; executable: true; programData: string;
      programDataOwner: string; deploymentSlot: string; upgradeAuthority: null; loadedImageSha256: string } };
};
type MintObservation = { address: string; owner: string; decimals: number; authority: string; freezeAuthority: null; supply: string };

function requireBinding(condition: boolean, field: string): asserts condition {
  if (!condition) throw new Error(`Configuration mismatch: ${field}`);
}
function equal(actual: unknown, expected: unknown, field: string) {
  requireBinding(actual === expected, `${field}: actual=${String(actual)}, expected=${String(expected)}`);
}
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const address = (value: string) => getAddress(value).toLowerCase();
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Read identified live observations only. No transactions, mining, credentials,
 * persistence or process ownership. This proves local configuration agreement,
 * not settlement, cross-chain proofs or production finality. Economic counters,
 * balances and supplies are observations, never required to remain zero.
 */
export async function verifyLiveConfiguration(input: LiveConfigurationInput): Promise<LiveConfigurationObservation> {
  const { provider, connection, minFinalizedSlot } = input;
  const evm = structuredClone(input.evmManifest);
  const source = structuredClone(input.solanaManifest);
  const deadline = Date.now() + 60_000;
  async function rpc<T>(field: string, operation: () => Promise<T>): Promise<T> {
    const remaining = Math.min(10_000, deadline - Date.now());
    if (remaining <= 0) throw new Error(`Configuration verification overall deadline exceeded: ${field}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Configuration RPC deadline exceeded: ${field}`)), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  requireBinding(Number.isSafeInteger(minFinalizedSlot) && minFinalizedSlot > 0, "minFinalizedSlot");
  equal(source.schemaVersion, 1, "source.schemaVersion");
  equal(source.programId, programId.toBase58(), "repository programId");
  const operator = new PublicKey(source.roles.operator);
  const executor = new PublicKey(source.roles.executor);
  // Validate byte widths, checksums, uint256 representation and distinct roles.
  buildInitializeArgs(evm, programId, operator, executor);
  buildInitializeArgs({ ...evm, ...source.deployment }, programId, operator, executor);
  const chainId = BigInt(await rpc("eth_chainId", () => provider.send("eth_chainId", []))).toString();
  equal(chainId, "31337", "actual RPC chainId");
  const block = BigInt(await rpc("eth_blockNumber", () => provider.send("eth_blockNumber", [])));
  requireBinding(block <= BigInt(Number.MAX_SAFE_INTEGER), "EVM block number safe integer");
  const blockNumber = Number(block);
  const blockTag = toQuantity(block);
  const canonical = await rpc("canonical EVM block", () => provider.send("eth_getBlockByNumber", [blockTag, false]));
  requireBinding(canonical && typeof canonical.hash === "string", "canonical EVM block hash");
  equal(BigInt(canonical.number).toString(), block.toString(), "canonical EVM block number");
  const getters = ["operator", "executor", "usdToken", "yesToken", "venue", "market"];
  const settlement = new Contract(evm.contracts.settlement, [
    "function domain() view returns (tuple(bytes32 sourceDomain,bytes32 destinationDomain,bytes32 solanaProgram,uint256 chainId,address settlement))",
    ...getters.map((name) => `function ${name}() view returns (${name === "market" ? "bytes32" : "address"})`),
  ], provider);
  const read = (contract: Contract, name: string) => rpc(`EVM ${name}`, () => contract.getFunction(name).staticCall({ blockTag }));
  const domain = await read(settlement, "domain");
  const [evmOperator, evmExecutor, cashToken, yesToken, venueAddress, market] = await Promise.all(getters.map((name) => read(settlement, name)));
  const destination: SharedConfiguration = {
    sourceDomain: domain.sourceDomain.toLowerCase(), destinationDomain: domain.destinationDomain.toLowerCase(),
    solanaProgram: domain.solanaProgram.toLowerCase(), chainId: domain.chainId.toString(), settlement: address(domain.settlement),
    venue: address(venueAddress), cashToken: address(cashToken), yesToken: address(yesToken),
    evmOperator: address(evmOperator), evmExecutor: address(evmExecutor), market: market.toLowerCase(),
  };
  equal(destination.chainId, chainId, "Settlement captured chainId");
  const codeBytes: Record<string, number> = {};
  await Promise.all(Object.entries(evm.contracts).map(async ([name, key]) => {
    const code = await rpc(`code ${name}`, () => provider.getCode(key, blockTag));
    requireBinding(code !== "0x", `nonempty ${name} code at ${key}`);
    codeBytes[name] = (code.length - 2) / 2;
  }));
  const venue = new Contract(venueAddress, ["function usdToken() view returns (address)",
    "function yesToken() view returns (address)", "function market() view returns (bytes32)"], provider);
  const observedVenue = { cashToken: address(await read(venue, "usdToken")), yesToken: address(await read(venue, "yesToken")),
    market: (await read(venue, "market")).toLowerCase() };
  for (const field of ["cashToken", "yesToken", "market"] as const) equal(observedVenue[field], destination[field], `venue.${field}`);
  const decimals = await Promise.all([cashToken, yesToken].map((key) => read(new Contract(key, ["function decimals() view returns (uint8)"], provider), "decimals")));
  decimals.forEach((value, index) => equal(value, 6n, `EVM ${index === 0 ? "USD" : "YES"} decimals`));

  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
  const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
  const cashMint = new PublicKey(source.mints.cash);
  const yesMint = new PublicKey(source.mints.yes);
  requireBinding(!cashMint.equals(yesMint), "distinct source mints");
  const ata = getAssociatedTokenAddressSync(cashMint, executor, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const expectedAccounts = { config, accounting, yesMintAuthority: yesAuthority, executorCashAta: ata,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  for (const [field, key] of Object.entries(expectedAccounts)) equal(source.accounts[field as keyof typeof expectedAccounts], key.toBase58(), `source manifest ${field}`);
  equal(source.programData, programData.toBase58(), "source manifest ProgramData");
  for (const [field, bump] of Object.entries({ config: configBump, accounting: accountingBump, yesMintAuthority: yesBump })) {
    equal(source.bumps[field as keyof typeof source.bumps], bump, `source manifest ${field} bump`);
  }
  const response = await rpc("finalized source accounts", () => connection.getMultipleAccountsInfoAndContext(
    [config, accounting, cashMint, yesMint, ata, programId, programData, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId],
    { commitment: "finalized", minContextSlot: minFinalizedSlot },
  ));
  requireBinding(response.context.slot >= minFinalizedSlot, "finalized response context slot");
  function account(index: number, owner: PublicKey, executable: boolean, field: string): AccountInfo<Buffer> {
    const info = response.value[index];
    requireBinding(info !== null, `${field} exists`);
    equal(info.owner.toBase58(), owner.toBase58(), `${field} owner`);
    equal(info.executable, executable, `${field} executable`);
    return info;
  }
  const configInfo = account(0, programId, false, "Config");
  equal(configInfo.data.length, 580, "Config size");
  requireBinding(configInfo.data.subarray(0, 8).equals(discriminator("Config")), "Config discriminator");
  // Decode the actual fixed Borsh account layout (not protocol hash encoding).
  let offset = 8;
  const bytes = (width: number) => { const result = configInfo.data.subarray(offset, offset + width); offset += width; return result; };
  const byte = () => bytes(1)[0];
  const hex = (width: number) => hexlify(bytes(width));
  const key = () => new PublicKey(bytes(32)).toBase58();
  const version = byte();
  const liveSource: SharedConfiguration = {
    sourceDomain: hex(32), destinationDomain: hex(32), solanaProgram: hex(32), chainId: BigInt(hex(32)).toString(),
    settlement: hex(20), venue: hex(20), cashToken: hex(20), yesToken: hex(20), evmOperator: hex(20), evmExecutor: hex(20), market: hex(32),
  };
  const outcome = byte();
  const local = { operator: key(), executor: key(), cashMint: key(), yesMint: key(), executorCashAta: key(),
    yesAuthority: key(), tokenProgram: key(), associatedTokenProgram: key(), systemProgram: key(), bump: byte(), yesAuthorityBump: byte() };
  equal(offset, configInfo.data.length, "Config layout consumed");
  equal(version, 1, "Config version"); equal(outcome, 0, "Config YES outcome");
  equal(liveSource.solanaProgram, hexlify(programId.toBytes()), "Config stored program identity raw bytes");
  // Live-to-live comparison precedes the comparisons with expected manifests.
  for (const field of Object.keys(destination) as (keyof SharedConfiguration)[]) {
    equal(liveSource[field], destination[field], `live source/Settlement ${field}`);
  }
  function expected(manifest: EvmDeploymentManifest | SolanaDeploymentManifest["deployment"]): SharedConfiguration {
    return { sourceDomain: manifest.sourceDomain.toLowerCase(), destinationDomain: manifest.destinationDomain.toLowerCase(),
      solanaProgram: manifest.solanaProgram.toLowerCase(), chainId: BigInt(manifest.chainId).toString(),
      settlement: address(manifest.contracts.settlement), venue: address(manifest.contracts.venue),
      cashToken: address(manifest.contracts.usd), yesToken: address(manifest.contracts.yes),
      evmOperator: address(manifest.roles.operator), evmExecutor: address(manifest.roles.executor), market: manifest.market.toLowerCase() };
  }
  for (const [label, manifest] of [["EVM manifest", evm], ["source deployment manifest", source.deployment]] as const) {
    const selected = expected(manifest);
    for (const field of Object.keys(selected) as (keyof SharedConfiguration)[]) equal(destination[field], selected[field], `${label} ${field}`);
  }
  const expectedLocal = { operator: operator.toBase58(), executor: executor.toBase58(), cashMint: cashMint.toBase58(), yesMint: yesMint.toBase58(),
    executorCashAta: ata.toBase58(), yesAuthority: yesAuthority.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), systemProgram: SystemProgram.programId.toBase58(), bump: configBump, yesAuthorityBump: yesBump };
  for (const field of Object.keys(local) as (keyof typeof local)[]) equal(local[field], expectedLocal[field], `Config ${field}`);
  const accountingInfo = account(1, programId, false, "Accounting");
  equal(accountingInfo.data.length, 105, "Accounting size");
  requireBinding(accountingInfo.data.subarray(0, 8).equals(discriminator("Accounting")), "Accounting discriminator");
  equal(new PublicKey(accountingInfo.data.subarray(8, 40)).toBase58(), config.toBase58(), "Accounting stored Config");
  equal(accountingInfo.data[104], accountingBump, "Accounting bump");
  const counters = Array.from({ length: 4 }, (_, index) => {
    const start = 40 + index * 16;
    return (accountingInfo.data.readBigUInt64LE(start) + (accountingInfo.data.readBigUInt64LE(start + 8) << 64n)).toString();
  });
  equal(source.mints.decimals, 6, "source manifest mint decimals");
  equal(source.mints.freezeAuthority, null, "source manifest freeze authority");
  equal(source.mints.cashAuthority, source.roles.initializer, "source cash authority/initializer");
  equal(source.mints.yesAuthority, yesAuthority.toBase58(), "source YES authority");
  function mint(index: number, mintKey: PublicKey, authority: string, field: string): MintObservation {
    const info = account(index, TOKEN_PROGRAM_ID, false, field);
    equal(info.data.length, 82, `${field} legacy mint size`);
    const decoded = unpackMint(mintKey, info, TOKEN_PROGRAM_ID);
    requireBinding(decoded.isInitialized, `${field} initialized`);
    equal(decoded.decimals, 6, `${field} decimals`);
    equal(decoded.mintAuthority?.toBase58(), authority, `${field} authority`);
    equal(decoded.freezeAuthority, null, `${field} freeze authority`);
    return { address: mintKey.toBase58(), owner: info.owner.toBase58(), decimals: decoded.decimals,
      authority, freezeAuthority: null, supply: decoded.supply.toString() };
  }
  const mints = { cash: mint(2, cashMint, source.mints.cashAuthority, "cash mint"), yes: mint(3, yesMint, yesAuthority.toBase58(), "YES mint") };
  const ataInfo = account(4, TOKEN_PROGRAM_ID, false, "executor cash ATA");
  equal(ataInfo.data.length, 165, "executor cash ATA legacy size");
  const decodedAta = unpackAccount(ata, ataInfo, TOKEN_PROGRAM_ID);
  equal(decodedAta.owner.toBase58(), executor.toBase58(), "executor cash ATA owner");
  equal(decodedAta.mint.toBase58(), cashMint.toBase58(), "executor cash ATA mint");
  requireBinding(decodedAta.isInitialized && !decodedAta.isFrozen && !decodedAta.isNative, "executor cash ATA state");
  equal(decodedAta.delegate, null, "executor cash ATA delegate");
  equal(decodedAta.delegatedAmount, 0n, "executor cash ATA delegated amount");
  equal(decodedAta.closeAuthority, null, "executor cash ATA close authority");
  const programInfo = account(5, loader, true, "program");
  equal(programInfo.data.length, 36, "program loader size");
  equal(programInfo.data.readUInt32LE(0), 2, "loader Program variant");
  equal(new PublicKey(programInfo.data.subarray(4, 36)).toBase58(), programData.toBase58(), "linked ProgramData");
  const data = account(6, loader, false, "ProgramData");
  requireBinding(data.data.length > 45, "ProgramData image exists");
  equal(data.data.readUInt32LE(0), 3, "loader ProgramData variant");
  equal(data.data[12], 0, "ProgramData removed upgrade authority");
  for (const [index, field] of [[7, "Token"], [8, "Associated Token"], [9, "System"]] as const) {
    requireBinding(response.value[index]?.executable === true, `${field} program executable`);
  }
  const rechecked = await rpc("recheck canonical EVM hash", () => provider.send("eth_getBlockByNumber", [blockTag, false]));
  equal(rechecked?.hash, canonical.hash, "canonical EVM block hash recheck");
  return {
    scope: "Live local configuration agreement at identified observations; no settlement or cross-chain finality proof",
    evm: { blockNumber, blockHash: canonical.hash, rpcChainId: chainId, configuration: destination,
      venue: observedVenue, tokenDecimals: { cash: decimals[0].toString(), yes: decimals[1].toString() }, codeBytes },
    solana: { contextSlot: response.context.slot, minContextSlot: minFinalizedSlot, commitment: "finalized", configuration: liveSource,
      config: { address: config.toBase58(), owner: configInfo.owner.toBase58(), dataHex: configInfo.data.toString("hex"), version, outcome, ...local },
      accounting: { address: accounting.toBase58(), owner: accountingInfo.owner.toBase58(), config: config.toBase58(), bump: accountingBump, counters },
      mints, executorCashAta: { address: ata.toBase58(), owner: decodedAta.owner.toBase58(), mint: decodedAta.mint.toBase58(), amount: decodedAta.amount.toString() },
      program: { address: programId.toBase58(), owner: programInfo.owner.toBase58(), executable: true, programData: programData.toBase58(),
        programDataOwner: data.owner.toBase58(), deploymentSlot: data.data.readBigUInt64LE(4).toString(), upgradeAuthority: null,
        loadedImageSha256: createHash("sha256").update(data.data.subarray(45)).digest("hex") } },
  };
}
