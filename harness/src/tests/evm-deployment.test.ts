import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { Contract, getCreateAddress, hexlify, Interface, JsonRpcProvider, type InterfaceAbi } from "ethers";
import type { EvmDeploymentInput } from "../evm-deployment.ts";

const { deployEvmFixture } = await import(new URL("../evm-deployment.ts", import.meta.url).href) as typeof import("../evm-deployment.ts");
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.EVM_DEPLOYMENT_RUNTIME;
assert.ok(runtime, "Use scripts/check-evm-deployment.sh with its fresh owned Anvil");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("evm-deployment-"));

function compiled(name: string): { abi: InterfaceAbi; bytecode: { object: string } } {
  return JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8"));
}

test("fresh local EVM deployment and independent setup verification", { timeout: 120_000 }, async (t) => {
  const provider = new JsonRpcProvider("http://127.0.0.1:18545", undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 100;
  const evidence: {
    scope: string; checks: string[]; preflight: unknown[]; observed: Record<string, unknown>; failure?: string;
  } = {
    scope: "Local EVM setup only; status-1 receipts do not establish cross-chain finality",
    checks: [], preflight: [], observed: {},
  };
  const persist = () => writeFileSync(join(runtime, "deployment-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failed = false;
    let failure: unknown;
    await t.test(name, async () => {
      try {
        await action();
        evidence.checks.push(name);
        persist();
      } catch (error) {
        failed = true;
        failure = error;
        throw error;
      }
    });
    // node:test records a failed child without rejecting t.test's promise.
    // Stop here rather than deploy after a failed preflight assertion.
    if (failed) throw failure;
  }
  try {
    assert.equal(BigInt(await provider.send("eth_chainId", [])), 31337n);
    assert.equal(BigInt(await provider.send("eth_blockNumber", [])), 0n);
    const [deployer, operator, executor] = await Promise.all([0, 1, 2].map((index) => provider.getSigner(index)));
    const roles = {
      deployer: await deployer.getAddress(), operator: await operator.getAddress(), executor: await executor.getAddress(),
    };
    assert.equal(new Set(Object.values(roles)).size, 3);
    const sourceDomain = randomBytes(32);
    const destinationDomain = randomBytes(32);
    assert.ok(sourceDomain.some((byte) => byte !== 0));
    assert.ok(destinationDomain.some((byte) => byte !== 0));
    assert.notDeepEqual(sourceDomain, destinationDomain);
    const solanaProgram = new PublicKey("7zLj7iNbNvV6m6nogUKgUuJKNw5wUWtfSvVTmcgqpfzK").toBytes();
    const market = Buffer.from("7777777777777777777777777777777777777777777777777777777777777777", "hex");
    const input: EvmDeploymentInput = { provider, deployer, operator, executor, sourceDomain, destinationDomain, solanaProgram, market };
    evidence.observed.selectedConfiguration = {
      sourceDomain: hexlify(sourceDomain), destinationDomain: hexlify(destinationDomain),
      solanaProgram: hexlify(solanaProgram), market: hexlify(market), roles,
    };
    async function activity() {
      return {
        blockNumber: BigInt(await provider.send("eth_blockNumber", [])).toString(),
        nonces: await Promise.all(Object.values(roles).map(async (address) =>
          BigInt(await provider.send("eth_getTransactionCount", [address, "latest"])).toString())),
      };
    }
    const rejected: [string, Partial<EvmDeploymentInput>, RegExp][] = [
      ...(["sourceDomain", "destinationDomain", "solanaProgram", "market"] as const).map((field): [string, Partial<EvmDeploymentInput>, RegExp] =>
        [`wrong ${field} byte length`, { [field]: new Uint8Array(31) }, /exactly 32 raw bytes/]),
      ...(["sourceDomain", "destinationDomain", "solanaProgram", "market"] as const).map((field): [string, Partial<EvmDeploymentInput>, RegExp] =>
        [`zero ${field}`, { [field]: new Uint8Array(32) }, /must be nonzero/]),
      ["equal deployment domains", { destinationDomain: sourceDomain }, /domains must be distinct/],
      ["aliased operator and executor", { executor: operator }, /distinct nonzero role addresses/],
      ["aliased deployer and operator", { operator: deployer }, /distinct nonzero role addresses/],
    ];
    for (const [name, overrides, error] of rejected) {
      await check(`preflight: ${name}`, async () => {
        const before = await activity();
        await assert.rejects(deployEvmFixture({ ...input, ...overrides }), error);
        const after = await activity();
        assert.deepEqual(after, before, "Rejected setup must not mine blocks or consume any role nonce");
        evidence.preflight.push({ name, before, after });
      });
    }
    // A different provider object is rejected even when it points to this same local node.
    await check("preflight: signer provider mismatch", async () => {
      const other = new JsonRpcProvider("http://127.0.0.1:18545");
      try {
        const before = await activity();
        await assert.rejects(deployEvmFixture({ ...input, provider: other }), /supplied provider/);
        const after = await activity();
        assert.deepEqual(after, before);
        evidence.preflight.push({ name: "signer provider mismatch", before, after });
      } finally {
        other.destroy();
      }
    });
    assert.deepEqual(await activity(), { blockNumber: "0", nonces: ["0", "0", "0"] });
    const manifest = await deployEvmFixture(input);
    writeFileSync(join(runtime, "deployment-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const addresses = {
      usd: getCreateAddress({ from: roles.deployer, nonce: 0n }),
      yes: getCreateAddress({ from: roles.deployer, nonce: 1n }),
      venue: getCreateAddress({ from: roles.deployer, nonce: 2n }),
      settlement: getCreateAddress({ from: roles.deployer, nonce: 3n }),
    };
    const tokenArtifact = compiled("MockERC20");
    const venueArtifact = compiled("MockVenue");
    const settlementArtifact = compiled("Settlement");
    const usd = new Contract(addresses.usd, tokenArtifact.abi, provider);
    const yes = new Contract(addresses.yes, tokenArtifact.abi, provider);
    const venue = new Contract(addresses.venue, venueArtifact.abi, provider);
    const settlement = new Contract(addresses.settlement, settlementArtifact.abi, provider);
    const read = async (contract: Contract, name: string, ...args: unknown[]) => contract.getFunction(name).staticCall(...args);

    await check("manifest agrees with independent inputs and derived deployment addresses", async () => {
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.chainId, "31337");
      assert.equal(manifest.outcome, 0);
      assert.equal(manifest.tokenDecimals, 6);
      for (const field of ["sourceDomain", "destinationDomain", "solanaProgram", "market"] as const) {
        assert.equal(manifest[field], hexlify(input[field]));
        assert.match(manifest[field], /^0x[0-9a-f]{64}$/);
      }
      assert.deepEqual(manifest.roles, roles);
      assert.deepEqual(manifest.contracts, addresses);
      assert.deepEqual(manifest.funding, { executorUsd: "100000000", venueYes: "200000000", executorAllowance: "100000000" });
    });
    await check("Settlement domain and every immutable binding", async () => {
      const domain = await read(settlement, "domain");
      assert.deepEqual(Array.from(domain), [hexlify(sourceDomain), hexlify(destinationDomain), hexlify(solanaProgram), 31337n, addresses.settlement]);
      const bindings: Record<string, string> = {
        operator: roles.operator, executor: roles.executor, usdToken: addresses.usd, yesToken: addresses.yes,
        venue: addresses.venue, market: hexlify(market),
      };
      const observed: Record<string, string> = {};
      for (const [name, expected] of Object.entries(bindings)) {
        observed[name] = await read(settlement, name);
        assert.equal(observed[name], expected);
      }
      evidence.observed.settlement = { domain: Array.from(domain, (value) => typeof value === "bigint" ? value.toString() : value), ...observed };
    });
    await check("venue bindings and token metadata/mint authorities", async () => {
      const observedVenue = {
        usdToken: await read(venue, "usdToken"), yesToken: await read(venue, "yesToken"), market: await read(venue, "market"),
      };
      assert.deepEqual(observedVenue, { usdToken: addresses.usd, yesToken: addresses.yes, market: hexlify(market) });
      evidence.observed.venue = observedVenue;
      const metadata = [];
      for (const [token, name, symbol] of [[usd, "Mock USD", "mUSD"], [yes, "Mock YES", "mYES"]] as const) {
        const actual = { name: await read(token, "name"), symbol: await read(token, "symbol"),
          decimals: (await read(token, "decimals")).toString(), mintAuthority: await read(token, "mintAuthority") };
        assert.deepEqual(actual, { name, symbol, decimals: "6", mintAuthority: roles.deployer });
        metadata.push(actual);
      }
      evidence.observed.tokens = metadata;
    });
    await check("exact balances, conservation, allowances and zero custody/counters", async () => {
      const participants = { ...roles, venue: addresses.venue, settlement: addresses.settlement };
      const balances: Record<string, Record<string, string>> = {};
      for (const [label, token, expectedSupply, recipient] of [
        ["usd", usd, 100_000_000n, "executor"], ["yes", yes, 200_000_000n, "venue"],
      ] as const) {
        let sum = 0n;
        balances[label] = {};
        for (const [name, address] of Object.entries(participants)) {
          const actual: bigint = await read(token, "balanceOf", address);
          assert.equal(actual, name === recipient ? expectedSupply : 0n, `${label} balance of ${name}`);
          balances[label][name] = actual.toString();
          sum += actual;
        }
        const supply: bigint = await read(token, "totalSupply");
        assert.equal(supply, expectedSupply);
        assert.equal(sum, supply, "Known fixture participants must conserve the complete supply");
        balances[label].supply = supply.toString();
        balances[label].sum = sum.toString();
      }
      const executorAllowance: bigint = await read(usd, "allowance", roles.executor, addresses.settlement);
      const venueAllowance: bigint = await read(usd, "allowance", addresses.settlement, addresses.venue);
      const cashSpent: bigint = await read(settlement, "totalCashSpent");
      const sharesPurchased: bigint = await read(settlement, "totalSharesPurchased");
      assert.equal(executorAllowance, 100_000_000n);
      assert.equal(venueAllowance, 0n);
      assert.equal(cashSpent, 0n);
      assert.equal(sharesPurchased, 0n);
      evidence.observed.balances = balances;
      evidence.observed.allowances = { executorToSettlementUsd: executorAllowance.toString(), settlementToVenueUsd: venueAllowance.toString() };
      evidence.observed.counters = { totalCashSpent: cashSpent.toString(), totalSharesPurchased: sharesPurchased.toString() };
    });
    await check("all seven actual transactions, successful receipts, canonical blocks and deployed code", async () => {
      const tokenInterface = new Interface(tokenArtifact.abi);
      const deployments = [
        ["usdDeployment", addresses.usd, tokenArtifact, ["Mock USD", "mUSD", roles.deployer]],
        ["yesDeployment", addresses.yes, tokenArtifact, ["Mock YES", "mYES", roles.deployer]],
        ["venueDeployment", addresses.venue, venueArtifact, [addresses.usd, addresses.yes, hexlify(market)]],
        ["settlementDeployment", addresses.settlement, settlementArtifact, [{ sourceDomain: hexlify(sourceDomain),
          destinationDomain: hexlify(destinationDomain), solanaProgram: hexlify(solanaProgram), operator: roles.operator,
          executor: roles.executor, usdToken: addresses.usd, yesToken: addresses.yes, venue: addresses.venue, market: hexlify(market) }]],
      ] as const;
      const expectedTransactions = new Map<string, { to: string | null; from: string; data: string; created: string | null }>();
      for (const [step, address, artifact, args] of deployments) {
        expectedTransactions.set(step, { to: null, from: roles.deployer, created: address,
          data: artifact.bytecode.object + new Interface(artifact.abi).encodeDeploy(args).slice(2) });
        assert.notEqual(await provider.getCode(address), "0x");
      }
      expectedTransactions.set("executorFunding", { to: addresses.usd, from: roles.deployer, created: null,
        data: tokenInterface.encodeFunctionData("mint", [roles.executor, 100_000_000n]) });
      expectedTransactions.set("venueFunding", { to: addresses.yes, from: roles.deployer, created: null,
        data: tokenInterface.encodeFunctionData("mint", [addresses.venue, 200_000_000n]) });
      expectedTransactions.set("executorApproval", { to: addresses.usd, from: roles.executor, created: null,
        data: tokenInterface.encodeFunctionData("approve", [addresses.settlement, 100_000_000n]) });
      assert.deepEqual(Object.keys(manifest.transactions), [...expectedTransactions.keys()]);
      const receipts = [];
      let expectedBlock = 1;
      for (const [step, recorded] of Object.entries(manifest.transactions)) {
        const actual = await provider.getTransactionReceipt(recorded.transactionHash);
        const transaction = await provider.getTransaction(recorded.transactionHash);
        assert.ok(actual && transaction);
        const expected = expectedTransactions.get(step)!;
        assert.equal(actual.status, 1);
        assert.equal(actual.hash, recorded.transactionHash);
        assert.equal(actual.blockNumber, recorded.blockNumber);
        assert.equal(actual.blockNumber, expectedBlock++);
        assert.equal(actual.blockHash, recorded.blockHash);
        assert.equal((await provider.getBlock(actual.blockNumber))?.hash, actual.blockHash);
        assert.equal(actual.contractAddress, expected.created);
        assert.equal(transaction.from, expected.from);
        assert.equal(transaction.to, expected.to);
        assert.equal(transaction.data, expected.data);
        assert.equal(transaction.chainId, 31337n);
        receipts.push({ step, transactionHash: actual.hash, blockNumber: actual.blockNumber, blockHash: actual.blockHash,
          status: actual.status, from: actual.from, to: actual.to, contractAddress: actual.contractAddress });
      }
      assert.deepEqual(await activity(), { blockNumber: "7", nonces: ["6", "0", "1"] });
      evidence.observed.receipts = receipts;
    });
    await check("intermediate funding states at actual setup receipt blocks", async () => {
      const snapshots = [];
      for (const [step, expectedUsd, expectedYes, expectedAllowance] of [
        ["settlementDeployment", 0n, 0n, 0n], ["executorFunding", 100_000_000n, 0n, 0n],
        ["venueFunding", 100_000_000n, 200_000_000n, 0n], ["executorApproval", 100_000_000n, 200_000_000n, 100_000_000n],
      ] as const) {
        const blockTag = manifest.transactions[step].blockNumber;
        const at = (contract: Contract, name: string, ...args: unknown[]) => read(contract, name, ...args, { blockTag });
        assert.equal(await at(usd, "totalSupply"), expectedUsd);
        assert.equal(await at(yes, "totalSupply"), expectedYes);
        assert.equal(await at(usd, "balanceOf", roles.executor), expectedUsd);
        assert.equal(await at(yes, "balanceOf", addresses.venue), expectedYes);
        assert.equal(await at(usd, "allowance", roles.executor, addresses.settlement), expectedAllowance);
        for (const token of [usd, yes]) assert.equal(await at(token, "balanceOf", addresses.settlement), 0n);
        assert.equal(await at(usd, "allowance", addresses.settlement, addresses.venue), 0n);
        assert.equal(await at(settlement, "totalCashSpent"), 0n);
        assert.equal(await at(settlement, "totalSharesPurchased"), 0n);
        snapshots.push({ step, blockNumber: blockTag, usdSupply: expectedUsd.toString(), yesSupply: expectedYes.toString(),
          executorUsd: expectedUsd.toString(), venueYes: expectedYes.toString(), executorAllowance: expectedAllowance.toString(),
          settlementUsd: "0", settlementYes: "0", settlementVenueAllowance: "0", totalCashSpent: "0", totalSharesPurchased: "0" });
      }
      evidence.observed.intermediateStates = snapshots;
    });
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    provider.destroy();
    persist();
  }
});
