import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { FetchRequest, JsonRpcProvider } from "ethers";
import type { EvmDeploymentManifest } from "./evm-deployment.ts";
import type { SolanaDeploymentManifest } from "./solana-deployment.ts";
import type { SourceOrderConnection } from "./source-order.ts";
import type { TerminalDiscoveryRpc } from "./terminal-discovery.ts";
import type { RecoveryObservation } from "./recovery-observation.ts";
import type { LiveConfigurationObservation } from "./live-configuration.ts";

export type WorkerInput = { user: string; nonce: string; minFinalizedSlot: number; fromBlock: string; toBlock: string };
export type Serialized<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: Serialized<T[K]> } : T;
type Read = { chain: "Solana" | "EVM"; method: string; params: unknown; response?: unknown };
export type WorkerOutput = {
  processId: number;
  observation: Serialized<RecoveryObservation>;
  recoveryReads: { configurationVerification: { observation: LiveConfigurationObservation; reads: Read[] }; source: Read[]; destination: Read[] };
};
const serialize = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const evmReads = ["eth_chainId", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"];

async function main() {
  let stdin = "";
  for await (const chunk of process.stdin) {
    stdin += chunk.toString();
    assert.ok(Buffer.byteLength(stdin) <= 4096, "Input exceeds the public identity budget");
  }
  const input: unknown = JSON.parse(stdin);
  assert.ok(input !== null && typeof input === "object" && !Array.isArray(input), "Expected one public input object");
  assert.deepEqual(Object.keys(input).sort(), ["fromBlock", "minFinalizedSlot", "nonce", "toBlock", "user"]);
  const selected = input as WorkerInput;
  assert.equal(typeof selected.user, "string", "Expected a public base58 user");
  const user = new PublicKey(selected.user);
  assert.equal(user.toBase58(), selected.user, "User must be canonical base58");
  assert.ok(!user.equals(PublicKey.default), "User must be nonzero");
  assert.ok(Number.isSafeInteger(selected.minFinalizedSlot) && selected.minFinalizedSlot > 0, "Expected a positive safe slot");
  function decimal(value: unknown, label: string) {
    assert.ok(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${label}: expected canonical unsigned decimal`);
    return BigInt(value);
  }
  const nonce = decimal(selected.nonce, "nonce"), fromBlock = decimal(selected.fromBlock, "fromBlock"), toBlock = decimal(selected.toBlock, "toBlock");
  assert.ok(nonce < (1n << 64n) - 1n, "Nonce exceeds the source identity bound");
  assert.ok(fromBlock <= toBlock && toBlock < (1n << 256n) && toBlock - fromBlock + 1n <= 2048n, "Expected 1 to 2048 uint256 blocks");

  const root = resolve(import.meta.dirname, "../..");
  const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
  assert.ok(runtime, "Expected runner runtime");
  assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
  assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
  assert.equal(realpathSync(runtime), resolve(runtime), "Runtime must not redirect through a symlink");
  // These are the only runtime files this process reads. Existing modules load their ABI/IDL.
  function manifest(name: string) {
    const path = join(runtime, name);
    assert.equal(realpathSync(path), path, "Public manifest must not redirect through a symlink");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const evmManifest = manifest("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const solanaManifest = manifest("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const configurationReads: Read[] = [], sourceReads: Read[] = [], destinationReads: Read[] = [];
  let recovering = false;
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      assert.equal(call.method, "getMultipleAccounts");
      assert.equal(call.params[1].commitment, "finalized");
      assert.equal(call.params[1].minContextSlot, selected.minFinalizedSlot);
      const read: Read = { chain: "Solana", method: call.method, params: call.params };
      (recovering ? sourceReads : configurationReads).push(read);
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      read.response = await response.clone().json();
      return response;
    },
  });
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  request.retryFunc = async () => false;
  const provider = new JsonRpcProvider(request, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const send = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    assert.ok((recovering ? evmReads : [...evmReads, "eth_blockNumber", "eth_getCode"]).includes(method), `Forbidden worker RPC: ${method}`);
    const read: Read = { chain: "EVM", method, params: structuredClone(params) };
    (recovering ? destinationReads : configurationReads).push(read);
    read.response = await send(method, params);
    return read.response;
  };
  try {
    const { verifyLiveConfiguration } = await import(new URL("./live-configuration.ts", import.meta.url).href) as typeof import("./live-configuration.ts");
    const { observeRecovery } = await import(new URL("./recovery-observation.ts", import.meta.url).href) as typeof import("./recovery-observation.ts");
    const configuration = await verifyLiveConfiguration({ provider, connection, evmManifest, solanaManifest, minFinalizedSlot: selected.minFinalizedSlot });
    const program = new PublicKey(solanaManifest.programId), config = new PublicKey(configuration.solana.config.address);
    const nonceSeed = Buffer.alloc(8); nonceSeed.writeBigUInt64BE(nonce);
    const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], program);
    const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), nonceSeed], program);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], program);
    let sourceAttempts = 0;
    const sourceConnection: SourceOrderConnection = {
      getMultipleAccountsInfoAndContext: async (keys, options) => {
        assert.equal(++sourceAttempts, 1, "Recovery permits one source read");
        assert.deepEqual(keys.map((key) => key.toBase58()), [config, userNonce, order, escrow].map((key) => key.toBase58()));
        assert.deepEqual(options, { commitment: "finalized", minContextSlot: selected.minFinalizedSlot });
        return connection.getMultipleAccountsInfoAndContext(keys, options);
      },
    };
    const destinationProvider: TerminalDiscoveryRpc = { send: (method, params) => {
      assert.ok(evmReads.includes(method));
      return provider.send(method, params);
    } };
    recovering = true;
    const observation = await observeRecovery({ sourceConnection, destinationProvider, expectedConfiguration: configuration,
      user, nonce, minFinalizedSlot: selected.minFinalizedSlot, fromBlock, toBlock });
    assert.equal(sourceReads.length, 1);
    process.stdout.write(serialize({ processId: process.pid, observation,
      recoveryReads: { configurationVerification: { observation: configuration, reads: configurationReads }, source: sourceReads, destination: destinationReads } }) + "\n");
  } finally { provider.destroy(); }
}

main().catch((error: unknown) => {
  // No input/environment dump: only public validation/RPC error details.
  const detail = error instanceof Error ? { name: error.name, message: error.message,
    code: (error as Error & { code?: unknown }).code } : { message: String(error) };
  process.stderr.write(serialize(detail) + "\n");
  process.exitCode = 1;
});
