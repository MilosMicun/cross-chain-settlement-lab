import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { Contract, FetchRequest, Interface, JsonRpcProvider, getCreateAddress, hexlify, type InterfaceAbi } from "ethers";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationInput, LiveConfigurationObservation, SharedConfiguration } from "../live-configuration.ts";

const { deployEvmFixture } = await import(new URL("../evm-deployment.ts", import.meta.url).href) as typeof import("../evm-deployment.ts");
const { initializeSolanaFixture } = await import(new URL("../solana-deployment.ts", import.meta.url).href) as typeof import("../solana-deployment.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-dual-chain-setup.sh with its two fresh owned nodes");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const programId = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const discriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hexBytes = (hex: string) => Buffer.from(hex.slice(2), "hex");
const normalized = (address: string) => address.toLowerCase();
function credential(name: string) {
  const path = join(runtime!, "credentials", `${name}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
function compiled(name: string): { abi: InterfaceAbi; bytecode: { object: string } } {
  return JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8"));
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  return info && { address: key.toBase58(), owner: info.owner.toBase58(), executable: info.executable,
    lamports: info.lamports, space: info.data.length, dataHex: info.data.toString("hex") };
}

test("two fresh live chains agree without any order or receipt transport", { timeout: 550_000 }, async (t) => {
  const request = new FetchRequest("http://127.0.0.1:18545");
  request.timeout = 15_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 100;
  let verifying = false;
  const verifierRpc: { chain: string; method: string }[] = [];
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      if (verifying) {
        const method = JSON.parse(String(init?.body)).method;
        verifierRpc.push({ chain: "Solana", method });
        assert.equal(method, "getMultipleAccounts", "Verifier may only read finalized accounts");
      }
      return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  });
  const originalProviderSend = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    if (verifying) {
      verifierRpc.push({ chain: "EVM", method });
      assert.ok(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method),
        `Unexpected verifier RPC: ${method}`);
    }
    return originalProviderSend(method, params);
  };
  const initializer = credential("initializer");
  const operator = credential("operator");
  const executor = credential("executor");
  const cashMint = credential("cash-mint");
  const yesMint = credential("yes-mint");
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
  const [config, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [accounting, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), config.toBuffer()], programId);
  const [yesAuthority, yesBump] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), config.toBuffer()], programId);
  const ata = getAssociatedTokenAddressSync(cashMint.publicKey, executor.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const keys = [config, accounting, cashMint.publicKey, yesMint.publicKey, ata];
  const evidence: { scope: string; localGenesisLimitation: unknown; checks: string[];
    observed: Record<string, unknown>; negativeChecks: unknown[]; failure?: string } = {
    scope: "Simultaneous live local configuration agreement at identified block/slot observations. No orders, deposits, purchases, cancellations or receipt transport. Setup receipts only, not a terminal-finality service or cryptographic cross-chain proof.",
    localGenesisLimitation: { deactivatedFeature: "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g",
      reason: "Agave 4.1.2 SIMD-0500 prevents authority removal for the repository's SBPF v0 genesis fixture" },
    checks: [], observed: {}, negativeChecks: [],
  };
  function persist() {
    writeFileSync(join(runtime, "agreement-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  }
  async function check(name: string, action: () => Promise<void>) {
    let failed = false;
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); }
      catch (error) { failed = true; failure = error; throw error; }
    });
    if (failed) throw failure;
  }
  let latestSlot = 0;
  let evm: EvmDeploymentManifest;
  let source: SolanaDeploymentManifest;
  let dataBefore: AccountInfo<Buffer>;
  let programBefore: AccountInfo<Buffer>;
  const accounts = () => connection.getMultipleAccountsInfo(keys, { commitment: "finalized", minContextSlot: latestSlot });
  const snapshot = async () => (await accounts()).map((info, index) => publicAccount(keys[index], info));
  async function finalized(signature: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === "finalized") {
        const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(receipt?.meta); assert.equal(status.err, null); assert.equal(receipt.meta.err, null);
        assert.equal(receipt.slot, status.slot); latestSlot = Math.max(latestSlot, receipt.slot);
        return receipt;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Source receipt finalization deadline exceeded: ${signature}`);
  }
  function emptyTokens(infos: (AccountInfo<Buffer> | null)[]) {
    for (const [index, mintKey, authority] of [[2, cashMint.publicKey, initializer.publicKey], [3, yesMint.publicKey, yesAuthority]] as const) {
      if (!infos[index]) continue;
      assert.equal(infos[index]!.data.length, MINT_SIZE);
      const mint = unpackMint(mintKey, infos[index], TOKEN_PROGRAM_ID);
      assert.equal(mint.decimals, 6); assert.equal(mint.isInitialized, true); assert.equal(mint.supply, 0n);
      assert.ok(mint.mintAuthority?.equals(authority)); assert.equal(mint.freezeAuthority, null);
    }
    if (infos[4]) {
      assert.equal(infos[4].data.length, ACCOUNT_SIZE);
      const token = unpackAccount(ata, infos[4], TOKEN_PROGRAM_ID);
      assert.ok(token.owner.equals(executor.publicKey)); assert.ok(token.mint.equals(cashMint.publicKey));
      assert.equal(token.amount, 0n); assert.equal(token.isInitialized, true); assert.equal(token.isFrozen, false);
      assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null); assert.equal(token.isNative, false);
    }
  }
  try {
    const [deployer, evmOperator, evmExecutor] = await Promise.all([0, 1, 2].map((index) => provider.getSigner(index)));
    const roles = { deployer: await deployer.getAddress(), operator: await evmOperator.getAddress(), executor: await evmExecutor.getAddress() };
    const sourceDomain = randomBytes(32);
    const destinationDomain = randomBytes(32);
    assert.ok(sourceDomain.some((byte) => byte !== 0) && destinationDomain.some((byte) => byte !== 0));
    assert.notDeepEqual(sourceDomain, destinationDomain);
    const market = Buffer.alloc(32, 0x77);
    const addresses = { usd: getCreateAddress({ from: roles.deployer, nonce: 0n }), yes: getCreateAddress({ from: roles.deployer, nonce: 1n }),
      venue: getCreateAddress({ from: roles.deployer, nonce: 2n }), settlement: getCreateAddress({ from: roles.deployer, nonce: 3n }) };
    const expectedShared: SharedConfiguration = { sourceDomain: hexlify(sourceDomain), destinationDomain: hexlify(destinationDomain),
      solanaProgram: hexlify(programId.toBytes()), chainId: "31337", settlement: normalized(addresses.settlement), venue: normalized(addresses.venue),
      cashToken: normalized(addresses.usd), yesToken: normalized(addresses.yes), evmOperator: normalized(roles.operator),
      evmExecutor: normalized(roles.executor), market: hexlify(market) };
    evidence.observed.selectedInputs = { ...expectedShared, evmRoles: roles, sourceRoles: { initializer: initializer.publicKey.toBase58(),
      operator: operator.publicKey.toBase58(), executor: executor.publicKey.toBase58() },
      sourceMints: { cash: cashMint.publicKey.toBase58(), yes: yesMint.publicKey.toBase58() } };
    const tokenArtifact = compiled("MockERC20");
    const venueArtifact = compiled("MockVenue");
    const settlementArtifact = compiled("Settlement");
    const usd = new Contract(addresses.usd, tokenArtifact.abi, provider);
    const yes = new Contract(addresses.yes, tokenArtifact.abi, provider);
    const venue = new Contract(addresses.venue, venueArtifact.abi, provider);
    const settlement = new Contract(addresses.settlement, settlementArtifact.abi, provider);
    const read = (contract: Contract, name: string, blockTag: number, ...args: unknown[]) => contract.getFunction(name).staticCall(...args, { blockTag });
    const expectedConfig = Buffer.concat([
      discriminator("Config"), Buffer.from([1]), sourceDomain, destinationDomain, programId.toBuffer(),
      Buffer.from(31337n.toString(16).padStart(64, "0"), "hex"), hexBytes(addresses.settlement), hexBytes(addresses.venue),
      hexBytes(addresses.usd), hexBytes(addresses.yes), hexBytes(roles.operator), hexBytes(roles.executor), market, Buffer.from([0]),
      operator.publicKey.toBuffer(), executor.publicKey.toBuffer(), cashMint.publicKey.toBuffer(), yesMint.publicKey.toBuffer(),
      ata.toBuffer(), yesAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), ASSOCIATED_TOKEN_PROGRAM_ID.toBuffer(), SystemProgram.programId.toBuffer(),
      Buffer.from([configBump, yesBump]),
    ]);
    const expectedAccounting = Buffer.concat([discriminator("Accounting"), config.toBuffer(), Buffer.alloc(64), Buffer.from([accountingBump])]);

    await check("fresh endpoints, independent identities and actual genesis-loaded SBF", async () => {
      assert.equal(BigInt(await provider.send("eth_chainId", [])), 31337n);
      assert.equal(BigInt(await provider.send("eth_blockNumber", [])), 0n);
      assert.equal((await connection.getVersion())["solana-core"], "4.1.2");
      assert.equal(new Set(Object.values(roles)).size, 3);
      assert.equal(new Set([initializer, operator, executor, cashMint, yesMint].map((key) => key.publicKey.toBase58())).size, 5);
      assert.deepEqual(await accounts(), [null, null, null, null, null]);
      const loadedProgram = await connection.getAccountInfo(programId, "finalized");
      const loadedData = await connection.getAccountInfo(programData, "finalized");
      assert.ok(loadedProgram?.executable && loadedProgram.owner.equals(loader));
      assert.equal(loadedProgram.data.readUInt32LE(0), 2); assert.equal(loadedProgram.data.length, 36);
      assert.ok(new PublicKey(loadedProgram.data.subarray(4)).equals(programData));
      assert.ok(loadedData && !loadedData.executable && loadedData.owner.equals(loader));
      assert.equal(loadedData.data.readUInt32LE(0), 3); assert.equal(loadedData.data[12], 1);
      assert.ok(new PublicKey(loadedData.data.subarray(13, 45)).equals(initializer.publicKey));
      const binary = readFileSync(join(root, "solana/target/deploy/settlement_lab.so"));
      assert.deepEqual(loadedData.data.subarray(45, 45 + binary.length), binary);
      assert.ok(loadedData.data.subarray(45 + binary.length).every((byte) => byte === 0));
      dataBefore = loadedData; programBefore = loadedProgram;
      evidence.observed.loadedSbf = { binarySha256: hash(binary), loadedImageSha256: hash(loadedData.data.subarray(45)),
        programData: programData.toBase58(), originalUpgradeAuthority: initializer.publicKey.toBase58() };
    });
    await check("deployEvmFixture uses selected domains and seven fresh transactions, then test mines two blocks", async () => {
      evm = await deployEvmFixture({ provider, deployer, operator: evmOperator, executor: evmExecutor,
        sourceDomain, destinationDomain, solanaProgram: programId.toBytes(), market });
      assert.deepEqual(evm.contracts, addresses); assert.deepEqual(evm.roles, roles);
      assert.equal(evm.sourceDomain, hexlify(sourceDomain)); assert.equal(evm.destinationDomain, hexlify(destinationDomain));
      assert.equal(evm.solanaProgram, hexlify(programId.toBytes())); assert.equal(evm.market, hexlify(market));
      assert.deepEqual(evm.funding, { executorUsd: "100000000", venueYes: "200000000", executorAllowance: "100000000" });
      assert.equal(BigInt(await provider.send("eth_blockNumber", [])), 7n);
      await provider.send("evm_mine", []); await provider.send("evm_mine", []);
      assert.equal(BigInt(await provider.send("eth_blockNumber", [])), 9n);
      writeFileSync(join(runtime, "evm-deployment-manifest.json"), JSON.stringify(evm, null, 2) + "\n");
    });
    await check("independent status-1 setup receipts, canonical hashes, senders and exact transaction inputs", async () => {
      const tokenInterface = new Interface(tokenArtifact.abi);
      const expected = [
        { step: "usdDeployment", from: roles.deployer, to: null, created: addresses.usd,
          data: tokenArtifact.bytecode.object + tokenInterface.encodeDeploy(["Mock USD", "mUSD", roles.deployer]).slice(2) },
        { step: "yesDeployment", from: roles.deployer, to: null, created: addresses.yes,
          data: tokenArtifact.bytecode.object + tokenInterface.encodeDeploy(["Mock YES", "mYES", roles.deployer]).slice(2) },
        { step: "venueDeployment", from: roles.deployer, to: null, created: addresses.venue,
          data: venueArtifact.bytecode.object + new Interface(venueArtifact.abi).encodeDeploy([addresses.usd, addresses.yes, hexlify(market)]).slice(2) },
        { step: "settlementDeployment", from: roles.deployer, to: null, created: addresses.settlement,
          data: settlementArtifact.bytecode.object + new Interface(settlementArtifact.abi).encodeDeploy([{ sourceDomain: hexlify(sourceDomain),
            destinationDomain: hexlify(destinationDomain), solanaProgram: hexlify(programId.toBytes()), operator: roles.operator, executor: roles.executor,
            usdToken: addresses.usd, yesToken: addresses.yes, venue: addresses.venue, market: hexlify(market) }]).slice(2) },
        { step: "executorFunding", from: roles.deployer, to: addresses.usd, created: null, data: tokenInterface.encodeFunctionData("mint", [roles.executor, 100_000_000n]) },
        { step: "venueFunding", from: roles.deployer, to: addresses.yes, created: null, data: tokenInterface.encodeFunctionData("mint", [addresses.venue, 200_000_000n]) },
        { step: "executorApproval", from: roles.executor, to: addresses.usd, created: null, data: tokenInterface.encodeFunctionData("approve", [addresses.settlement, 100_000_000n]) },
      ];
      assert.deepEqual(Object.keys(evm.transactions), expected.map((item) => item.step));
      const receipts = [];
      for (const [index, item] of expected.entries()) {
        const saved = evm.transactions[item.step as keyof typeof evm.transactions];
        const actual = await provider.getTransactionReceipt(saved.transactionHash);
        const transaction = await provider.getTransaction(saved.transactionHash);
        assert.ok(actual && transaction); assert.equal(actual.status, 1);
        assert.equal(actual.blockNumber, index + 1); assert.equal(actual.blockNumber, saved.blockNumber);
        assert.equal(actual.blockHash, saved.blockHash); assert.equal(actual.hash, saved.transactionHash);
        assert.equal((await provider.getBlock(actual.blockNumber))?.hash, actual.blockHash);
        assert.ok(9 >= actual.blockNumber + 2); assert.equal(actual.contractAddress, item.created);
        assert.equal(transaction.from, item.from); assert.equal(transaction.to, item.to); assert.equal(transaction.data, item.data);
        assert.equal(transaction.chainId, 31337n);
        receipts.push({ step: item.step, status: actual.status, transactionHash: actual.hash, blockNumber: actual.blockNumber,
          blockHash: actual.blockHash, from: actual.from, to: actual.to, contractAddress: actual.contractAddress, additionalBlocks: 9 - actual.blockNumber });
      }
      evidence.observed.evmSetupReceipts = receipts;
    });
    await check("EVM intermediate funding balances, custody, counters and allowance at setup blocks", async () => {
      const intermediate = [];
      for (const [block, cash, shares, allowance] of [[4, 0n, 0n, 0n], [5, 100_000_000n, 0n, 0n],
        [6, 100_000_000n, 200_000_000n, 0n], [7, 100_000_000n, 200_000_000n, 100_000_000n]] as const) {
        assert.equal(await read(usd, "totalSupply", block), cash); assert.equal(await read(yes, "totalSupply", block), shares);
        assert.equal(await read(usd, "balanceOf", block, roles.executor), cash); assert.equal(await read(yes, "balanceOf", block, addresses.venue), shares);
        assert.equal(await read(usd, "allowance", block, roles.executor, addresses.settlement), allowance);
        for (const token of [usd, yes]) assert.equal(await read(token, "balanceOf", block, addresses.settlement), 0n);
        assert.equal(await read(usd, "allowance", block, addresses.settlement, addresses.venue), 0n);
        assert.equal(await read(settlement, "totalCashSpent", block), 0n); assert.equal(await read(settlement, "totalSharesPurchased", block), 0n);
        intermediate.push({ blockNumber: block, blockHash: (await provider.getBlock(block))?.hash, usdSupply: cash.toString(), yesSupply: shares.toString(),
          executorUsd: cash.toString(), venueYes: shares.toString(), executorAllowance: allowance.toString(), settlementUsd: "0", settlementYes: "0",
          settlementVenueAllowance: "0", totalCashSpent: "0", totalSharesPurchased: "0" });
      }
      evidence.observed.evmIntermediateStates = intermediate;
    });
    await check("initializeSolanaFixture uses that live deployment and four finalized empty source setup stages", async () => {
      const sent: string[] = [];
      const intermediate: unknown[] = [];
      const originalSend = connection.sendRawTransaction.bind(connection);
      connection.sendRawTransaction = async (...args: Parameters<Connection["sendRawTransaction"]>) => {
        const step = sent.length; assert.ok(step < 4);
        if (step > 0) await finalized(sent[step - 1]);
        const infos = await accounts(); assert.equal(infos[0], null); assert.equal(infos[1], null);
        for (let index = 2; index < 5; index++) assert.equal(infos[index] !== null, index < 2 + step);
        emptyTokens(infos);
        intermediate.push({ beforeStep: ["cashMint", "yesMint", "executorCashAta", "initialize"][step], minFinalizedSlot: latestSlot,
          accounts: infos.map((info, index) => publicAccount(keys[index], info)) });
        const signature = await originalSend(...args); sent.push(signature); return signature;
      };
      try {
        source = await initializeSolanaFixture({ connection, initializer, evmManifest: evm, programId,
          operator: operator.publicKey, executor: executor.publicKey, cashMint, yesMint });
      } finally { connection.sendRawTransaction = originalSend; }
      assert.equal(sent.length, 4); assert.equal(intermediate.length, 4);
      const receipts = [];
      for (const [index, [step, saved]] of Object.entries(source.transactions).entries()) {
        assert.equal(saved.signature, sent[index]); const receipt = await finalized(saved.signature);
        assert.equal(saved.finalizedSlot, receipt.slot);
        receipts.push({ step, signature: saved.signature, finalizedSlot: receipt.slot, error: receipt.meta!.err });
      }
      assert.deepEqual(source.deployment, { chainId: evm.chainId, sourceDomain: hexlify(sourceDomain), destinationDomain: hexlify(destinationDomain),
        solanaProgram: hexlify(programId.toBytes()), market: hexlify(market), outcome: 0, tokenDecimals: 6, roles, contracts: addresses });
      assert.equal(source.programId, programId.toBase58()); assert.equal(source.programData, programData.toBase58());
      assert.deepEqual(source.roles, { initializer: initializer.publicKey.toBase58(), operator: operator.publicKey.toBase58(), executor: executor.publicKey.toBase58() });
      assert.deepEqual(source.accounts, { config: config.toBase58(), accounting: accounting.toBase58(), yesMintAuthority: yesAuthority.toBase58(),
        executorCashAta: ata.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        systemProgram: SystemProgram.programId.toBase58() });
      assert.deepEqual(source.bumps, { config: configBump, accounting: accountingBump, yesMintAuthority: yesBump });
      assert.deepEqual(source.mints, { cash: cashMint.publicKey.toBase58(), yes: yesMint.publicKey.toBase58(), decimals: 6,
        cashAuthority: initializer.publicKey.toBase58(), yesAuthority: yesAuthority.toBase58(), freezeAuthority: null });
      assert.deepEqual((await accounts())[0]?.data, expectedConfig); assert.deepEqual((await accounts())[1]?.data, expectedAccounting);
      evidence.observed.sourceIntermediateStates = intermediate; evidence.observed.sourceSetupReceipts = receipts;
      writeFileSync(join(runtime, "solana-deployment-manifest.json"), JSON.stringify(source, null, 2) + "\n");
    });
    await check("official CLI finalized SetAuthority(None) preserves loaded SBF and all protocol records", async () => {
      const before = await snapshot();
      const oldSignatures = new Set((await connection.getSignaturesForAddress(programData, { limit: 100 }, "finalized")).map((item) => item.signature));
      const path = join(runtime, "credentials/initializer.json");
      const result = await promisify(execFile)("solana", ["--config", join(runtime, "solana.yml"), "--url", connection.rpcEndpoint,
        "--keypair", path, "--commitment", "finalized", "--output", "json", "program", "set-upgrade-authority",
        programId.toBase58(), "--upgrade-authority", path, "--final"], { timeout: 60_000 });
      writeFileSync(join(runtime, "remove-authority.log"), result.stdout + result.stderr);
      const added = (await connection.getSignaturesForAddress(programData, { limit: 100 }, "finalized")).filter((item) => !oldSignatures.has(item.signature));
      assert.equal(added.length, 1); const receipt = await finalized(added[0].signature);
      const messageKeys = receipt.transaction.message.getAccountKeys();
      const ix = receipt.transaction.message.compiledInstructions.find((item) => messageKeys.get(item.programIdIndex)?.equals(loader));
      assert.ok(ix); assert.deepEqual(Buffer.from(ix.data), Buffer.from([4, 0, 0, 0]));
      assert.equal(ix.accountKeyIndexes.length, 2);
      assert.ok(messageKeys.get(ix.accountKeyIndexes[0])?.equals(programData));
      assert.ok(messageKeys.get(ix.accountKeyIndexes[1])?.equals(initializer.publicKey));
      const data = await connection.getAccountInfo(programData, { commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(data && data.owner.equals(loader)); assert.equal(data.data[12], 0);
      assert.equal(data.lamports, dataBefore.lamports); assert.equal(data.data.length, dataBefore.data.length);
      assert.deepEqual(data.data.subarray(45), dataBefore.data.subarray(45));
      assert.deepEqual(await connection.getAccountInfo(programId, "finalized"), programBefore);
      assert.deepEqual(await snapshot(), before);
      evidence.observed.authorityRemoval = { signature: added[0].signature, finalizedSlot: receipt.slot, error: null,
        upgradeAuthority: null, loadedImageSha256: hash(data.data.subarray(45)), protocolStateUnchanged: true };
    });

    async function economicState(block: number) {
      const balances: Record<string, Record<string, string>> = {};
      for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
        balances[label] = { supply: (await read(token, "totalSupply", block)).toString() };
        for (const [name, key] of Object.entries({ ...roles, venue: addresses.venue, settlement: addresses.settlement })) {
          balances[label][name] = (await read(token, "balanceOf", block, key)).toString();
        }
      }
      return { balances, executorAllowance: (await read(usd, "allowance", block, roles.executor, addresses.settlement)).toString(),
        venueAllowance: (await read(usd, "allowance", block, addresses.settlement, addresses.venue)).toString(),
        totalCashSpent: (await read(settlement, "totalCashSpent", block)).toString(), totalSharesPurchased: (await read(settlement, "totalSharesPurchased", block)).toString() };
    }
    await check("exact initial EVM economics, empty SPL assets, zero Accounting and only Config/Accounting records", async () => {
      const economic = await economicState(9);
      assert.deepEqual(economic, { balances: {
        usd: { supply: "100000000", deployer: "0", operator: "0", executor: "100000000", venue: "0", settlement: "0" },
        yes: { supply: "200000000", deployer: "0", operator: "0", executor: "0", venue: "200000000", settlement: "0" } },
      executorAllowance: "100000000", venueAllowance: "0", totalCashSpent: "0", totalSharesPurchased: "0" });
      for (const token of [usd, yes]) {
        assert.equal(await read(token, "mintAuthority", 9), roles.deployer); assert.equal(await read(token, "decimals", 9), 6n);
      }
      const infos = await accounts(); emptyTokens(infos);
      assert.deepEqual(infos[0]?.data, expectedConfig); assert.deepEqual(infos[1]?.data, expectedAccounting);
      const owned = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: latestSlot });
      assert.deepEqual(owned.map((item) => item.pubkey.toBase58()).sort(), [config.toBase58(), accounting.toBase58()].sort());
      for (const name of ["Order", "UserNonce"]) assert.equal(owned.filter((item) => item.account.data.subarray(0, 8).equals(discriminator(name))).length, 0);
      evidence.observed.initialEconomicState = economic;
      evidence.observed.sourceInitialState = { accounts: await snapshot(), protocolAccounts: owned.map((item) => item.pubkey.toBase58()),
        accountingCounters: ["0", "0", "0", "0"], cashSupply: "0", yesSupply: "0", executorCashBalance: "0", orderCount: 0, userNonceCount: 0 };
    });
    const verificationInput: LiveConfigurationInput = { provider, connection, evmManifest: evm!, solanaManifest: source!, minFinalizedSlot: latestSlot };
    async function activity() {
      const block = Number(BigInt(await provider.send("eth_blockNumber", [])));
      const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: latestSlot });
      const signatures = {} as Record<string, string[]>;
      for (const key of [initializer.publicKey, programId, programData, ...keys]) {
        signatures[key.toBase58()] = (await connection.getSignaturesForAddress(key, { limit: 100 }, "finalized")).map((item) => item.signature);
      }
      const data = await connection.getAccountInfo(programData, { commitment: "finalized", minContextSlot: latestSlot }); assert.ok(data);
      return { evmBlock: block, evmNonces: await Promise.all(Object.values(roles).map(async (key) => BigInt(await provider.send("eth_getTransactionCount", [key, "latest"])).toString())),
        economics: await economicState(block), sourceAccounts: await snapshot(), signatures,
        protocol: protocol.map((item) => publicAccount(item.pubkey, item.account)).sort((a, b) => a!.address.localeCompare(b!.address)),
        programDataHash: hash(data.data) };
    }
    async function readOnlyVerification(input: LiveConfigurationInput, rejection?: RegExp) {
      const before = await activity(); const beforeCount = verifierRpc.length;
      verifying = true;
      let result: LiveConfigurationObservation | undefined;
      let rejectedMessage: string | undefined;
      try {
        if (rejection) {
          await assert.rejects(verifyLiveConfiguration(input), (error: unknown) => {
            assert.ok(error instanceof Error); assert.match(error.message, rejection); rejectedMessage = error.message; return true;
          });
        } else { result = await verifyLiveConfiguration(input); }
      } finally { verifying = false; }
      const after = await activity(); assert.deepEqual(after, before, "Verifier cannot send transactions, mine, pay fees or change any protocol state");
      const calls = verifierRpc.slice(beforeCount);
      assert.ok(calls.some((item) => item.chain === "EVM" && item.method === "eth_call"));
      assert.ok(calls.some((item) => item.chain === "Solana" && item.method === "getMultipleAccounts"));
      return { result, rejectedMessage, calls, transactionsSent: 0, protocolStateUnchanged: true, before, after };
    }
    await check("live verifier agrees with independent selected inputs, actual getters and raw Config at recorded observations", async () => {
      const checked = await readOnlyVerification(verificationInput); const observed = checked.result!;
      assert.equal((await connection.getVersion())["solana-core"], "4.1.2"); assert.equal(BigInt(await provider.send("eth_chainId", [])), 31337n);
      assert.equal(observed.evm.blockNumber, 9); assert.equal((await provider.getBlock(9))?.hash, observed.evm.blockHash);
      assert.ok(observed.solana.contextSlot >= latestSlot);
      assert.deepEqual(observed.evm.configuration, expectedShared); assert.deepEqual(observed.solana.configuration, expectedShared);
      assert.equal(observed.evm.rpcChainId, "31337"); assert.deepEqual(observed.evm.tokenDecimals, { cash: "6", yes: "6" });
      for (const [name, key] of Object.entries(addresses)) {
        assert.equal(observed.evm.codeBytes[name], ((await provider.getCode(key, 9)).length - 2) / 2);
        assert.ok(observed.evm.codeBytes[name] > 0);
      }
      const actualDomain = await read(settlement, "domain", observed.evm.blockNumber);
      assert.deepEqual(Array.from(actualDomain), [hexlify(sourceDomain), hexlify(destinationDomain), hexlify(programId.toBytes()), 31337n, addresses.settlement]);
      const getters = { operator: roles.operator, executor: roles.executor, usdToken: addresses.usd, yesToken: addresses.yes, venue: addresses.venue, market: hexlify(market) };
      const actualGetters: Record<string, string> = {};
      for (const [field, expected] of Object.entries(getters)) { actualGetters[field] = await read(settlement, field, 9); assert.equal(actualGetters[field], expected); }
      assert.deepEqual(observed.evm.venue, { cashToken: normalized(await read(venue, "usdToken", 9)),
        yesToken: normalized(await read(venue, "yesToken", 9)), market: await read(venue, "market", 9) });
      const raw = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot: observed.solana.contextSlot });
      assert.deepEqual(raw.value[0]?.data, expectedConfig); assert.deepEqual(hexBytes(`0x${observed.solana.config.dataHex}`), expectedConfig);
      assert.deepEqual(raw.value[1]?.data, expectedAccounting); assert.deepEqual(observed.solana.accounting.counters, ["0", "0", "0", "0"]);
      assert.deepEqual(observed.solana.config, { address: config.toBase58(), owner: programId.toBase58(), dataHex: expectedConfig.toString("hex"),
        version: 1, outcome: 0, bump: configBump, yesAuthorityBump: yesBump, operator: operator.publicKey.toBase58(), executor: executor.publicKey.toBase58(),
        cashMint: cashMint.publicKey.toBase58(), yesMint: yesMint.publicKey.toBase58(), executorCashAta: ata.toBase58(), yesAuthority: yesAuthority.toBase58(),
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(), associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), systemProgram: SystemProgram.programId.toBase58() });
      assert.deepEqual(observed.solana.accounting, { address: accounting.toBase58(), owner: programId.toBase58(), config: config.toBase58(),
        bump: accountingBump, counters: ["0", "0", "0", "0"] });
      assert.deepEqual(observed.solana.mints, {
        cash: { address: cashMint.publicKey.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: initializer.publicKey.toBase58(), freezeAuthority: null, supply: "0" },
        yes: { address: yesMint.publicKey.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, authority: yesAuthority.toBase58(), freezeAuthority: null, supply: "0" } });
      assert.deepEqual(observed.solana.executorCashAta, { address: ata.toBase58(), owner: executor.publicKey.toBase58(), mint: cashMint.publicKey.toBase58(), amount: "0" });
      assert.equal(observed.solana.program.address, programId.toBase58()); assert.equal(observed.solana.program.owner, loader.toBase58());
      assert.equal(observed.solana.program.programData, programData.toBase58()); assert.equal(observed.solana.program.programDataOwner, loader.toBase58());
      assert.equal(observed.solana.program.executable, true); assert.equal(observed.solana.program.upgradeAuthority, null);
      assert.equal(observed.solana.program.deploymentSlot, dataBefore.data.readBigUInt64LE(4).toString());
      assert.equal(observed.solana.program.loadedImageSha256, hash(dataBefore.data.subarray(45)));
      evidence.observed.agreement = observed;
      evidence.observed.independentComparison = { actualGetters, expectedShared, expectedConfigHex: expectedConfig.toString("hex"),
        expectedAccountingHex: expectedAccounting.toString("hex"), rawConfigResponseContextSlot: raw.context.slot,
        bothEndpointsReachable: true, selectedInputsMatched: true, rawBytesMatched: true };
      evidence.observed.readOnlySuccess = { ...checked, result: undefined };
    });
    const wrongDomain = hexlify(Buffer.from(sourceDomain).map((byte, index) => index === 0 ? byte ^ 1 : byte));
    const negatives: [string, LiveConfigurationInput, RegExp][] = [
      ["altered expected source domain", { ...verificationInput, evmManifest: { ...evm!, sourceDomain: wrongDomain } }, /EVM manifest sourceDomain/],
      ["altered expected destination token binding", { ...verificationInput, solanaManifest: { ...source!, deployment: {
        ...source!.deployment, contracts: { ...source!.deployment.contracts, yes: addresses.venue } } } }, /source deployment manifest yesToken/],
      ["altered expected source operator", { ...verificationInput, solanaManifest: { ...source!, roles: {
        ...source!.roles, operator: initializer.publicKey.toBase58() } } }, /Config operator/],
    ];
    for (const [name, input, rejection] of negatives) {
      await check(`read-only rejection: ${name}`, async () => {
        const checked = await readOnlyVerification(input, rejection);
        evidence.negativeChecks.push({ name, ...checked });
      });
    }
    evidence.observed.verifierRpcCalls = verifierRpc;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    provider.destroy(); persist();
  }
});
