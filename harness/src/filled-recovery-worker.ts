import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { FetchRequest, JsonRpcProvider } from "ethers";
import anchor from "@anchor-lang/core";
import type { SettlementLab } from "../../solana/target/types/settlement_lab.ts";
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
  submissionCount: number; credentialReads: number; signingCount: number;
  deliveryReads: Read[];
  delivery: { signature: string; finalizedSlot: number; fee: string; source: Serialized<RecoveryObservation["source"]> } | null;
  processId: number;
  observation: Serialized<RecoveryObservation>;
  recoveryReads: { configurationVerification: { observation: LiveConfigurationObservation; reads: Read[] }; source: Read[]; destination: Read[] };
};
const serialize = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const evmReads = ["eth_chainId", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"];

// This deadline includes stdin, configuration, discovery and finalization. A timeout
// never establishes nonexecution; the signed public signature remains available.
let result: Partial<WorkerOutput> = { processId: process.pid, submissionCount: 0, credentialReads: 0, signingCount: 0, deliveryReads: [], delivery: null };
let knownSignature: string | undefined;
let emitted = false;
function emit(extra: object = {}, flushed?: () => void) {
  if (!emitted) { emitted = true; process.stdout.write(serialize({ ...result, ...extra }) + "\n", flushed); }
}
const lifetime = setTimeout(() => {
  // The parent drains stdout. Flush the public result before exiting rather
  // than truncating a buffered signature/evidence payload on a pipe.
  emit({ failure: "Worker lifetime exceeded; execution outcome may be unknown", knownSignature }, () => process.exit(1));
  setTimeout(() => process.exit(1), 1000);
}, 140_000);

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
  // Observation reads only public manifests; delivery may later read operator.json.
  // Existing modules load the required ABI/IDL files.
  function manifest(name: string) {
    const path = join(runtime, name);
    assert.equal(realpathSync(path), path, "Public manifest must not redirect through a symlink");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const evmManifest = manifest("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const solanaManifest = manifest("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const configurationReads: Read[] = [], sourceReads: Read[] = [], destinationReads: Read[] = [];
  let recovering = false, delivering = false;
  const deliveryReads = result.deliveryReads!;
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const call = JSON.parse(String(init?.body));
      if (!delivering) {
        assert.equal(call.method, "getMultipleAccounts");
        assert.equal(call.params[1].commitment, "finalized");
        assert.equal(call.params[1].minContextSlot, selected.minFinalizedSlot);
      } else {
        assert.ok(["getLatestBlockhash", "sendTransaction", "getSignatureStatuses", "getTransaction", "getMultipleAccounts"].includes(call.method), `Forbidden delivery RPC: ${call.method}`);
        if (call.method === "sendTransaction") {
          assert.equal(result.submissionCount, 0, "Broadcast at most once");
          assert.equal(call.params[1].maxRetries, 0);
          assert.equal(call.params[1].preflightCommitment, "finalized");
          result.submissionCount = 1;
        } else if (call.method === "getSignatureStatuses") {
          assert.deepEqual(call.params, [[knownSignature], { searchTransactionHistory: true }]);
        } else {
          assert.equal(call.params[call.method === "getTransaction" || call.method === "getMultipleAccounts" ? 1 : 0].commitment, "finalized");
        }
      }
      const read: Read = { chain: "Solana", method: call.method, params: call.params };
      (delivering ? deliveryReads : recovering ? sourceReads : configurationReads).push(read);
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
    const programKey = new PublicKey(solanaManifest.programId), config = new PublicKey(configuration.solana.config.address);
    const nonceSeed = Buffer.alloc(8); nonceSeed.writeBigUInt64BE(nonce);
    const [userNonce] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.toBuffer()], programKey);
    const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.toBuffer(), nonceSeed], programKey);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programKey);
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
    result = { ...result, observation: JSON.parse(serialize(observation)),
      recoveryReads: { configurationVerification: { observation: configuration, reads: configurationReads }, source: sourceReads, destination: destinationReads } };
    if (observation.plan.kind === "Wait" || observation.plan.kind === "Complete") { emit(); return; }
    assert.equal(observation.plan.kind, "DeliverFilled", "Unsupported recovery action");
    const recovered = observation.source, destination = observation.destination;
    assert.ok(recovered.state === "Pending" || recovered.state === "CancelRequested", "Requires active source");
    assert.equal(recovered.acceptedReceipt, null);
    assert.equal(destination.kind, "Observed"); assert.ok(destination.kind === "Observed");
    assert.equal(destination.observation.kind, "Confirmed"); assert.ok(destination.observation.kind === "Confirmed");
    assert.equal(destination.observation.receipt.terminal, 1);
    const { Program } = anchor;
    const idlPath = join(root, "solana/target/idl/settlement_lab.json");
    assert.equal(realpathSync(idlPath), idlPath, "IDL must not redirect through a symlink");
    const program = new Program<SettlementLab>(JSON.parse(readFileSync(idlPath, "utf8")), { connection });
    const { buildAcceptFilledInstruction } = await import(new URL("./filled-delivery.ts", import.meta.url).href) as typeof import("./filled-delivery.ts");
    // Preserve the actual lifecycle, including cancellation history. Validate the
    // real builder before accessing the only credential this process may read.
    const instruction = await buildAcceptFilledInstruction({ program, expectedConfiguration: configuration,
      sourceOrder: recovered, observation: destination.observation });
    const credentials = join(runtime, "credentials"), path = join(credentials, "operator.json");
    assert.equal(realpathSync(credentials), credentials, "Credentials directory must not be redirected");
    assert.ok(statSync(credentials).isDirectory());
    assert.equal(statSync(credentials).mode & 0o777, 0o700);
    assert.equal(realpathSync(path), path, "Operator credential must not be redirected");
    const file = statSync(path); assert.ok(file.isFile());
    assert.equal(file.mode & 0o777, 0o600); assert.ok(file.size <= 4096);
    result.credentialReads = 1;
    let secret: unknown;
    try { secret = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid operator credential format"); }
    assert.ok(Array.isArray(secret) && secret.length === 64
      && secret.every((byte: unknown) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255), "Invalid operator credential bytes");
    let operator: Keypair;
    try { operator = Keypair.fromSecretKey(Uint8Array.from(secret)); } catch { throw new Error("Invalid operator credential key"); }
    assert.equal(operator.publicKey.toBase58(), configuration.solana.config.operator, "Operator differs from freshly verified Config");
    delivering = true;
    const block = await connection.getLatestBlockhash({ commitment: "finalized", minContextSlot: recovered.contextSlot });
    const transaction = new Transaction({ ...block, feePayer: operator.publicKey }).add(instruction);
    transaction.sign(operator); result.signingCount = 1;
    assert.ok(transaction.signature);
    knownSignature = anchor.utils.bytes.bs58.encode(transaction.signature);
    const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "finalized", maxRetries: 0 });
    assert.equal(signature, knownSignature);
    const deadline = Date.now() + 60_000;
    for (let polls = 0; polls < 300 && Date.now() < deadline; polls++) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error(`Submitted transaction failed: ${signature}`);
      if (status?.confirmationStatus === "finalized") {
        const record = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(record?.meta); assert.equal(record.meta.err, null); assert.equal(record.slot, status.slot);
        assert.ok(Number.isSafeInteger(record.meta.fee) && record.meta.fee >= 0);
        const { readFinalizedRecoveryOrder } = await import(new URL("./source-order.ts", import.meta.url).href) as typeof import("./source-order.ts");
        const completed = await readFinalizedRecoveryOrder({ connection, expectedConfiguration: configuration,
          user, nonce, minFinalizedSlot: record.slot });
        assert.equal(completed.state, "Settled"); assert.ok(completed.state === "Settled");
        assert.equal(completed.cancellationRequested, recovered.cancellationRequested);
        assert.deepEqual(completed.acceptedReceipt, { terminal: 1, filledQuantity: destination.observation.receipt.filledQuantity, receiptHash: observation.plan.receiptHash });
        result.delivery = JSON.parse(serialize({ signature, finalizedSlot: record.slot, fee: BigInt(record.meta.fee), source: completed }));
        emit(); return;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error("Finalization deadline exceeded; execution outcome may be unknown");
  } finally { provider.destroy(); }
}

main().catch((error: unknown) => {
  // No input/environment dump: only public validation/RPC error details.
  const detail = error instanceof Error ? { name: error.name, message: error.message,
    code: (error as Error & { code?: unknown }).code } : { message: String(error) };
  emit({ failure: detail, knownSignature });
  process.stderr.write(serialize({ ...detail, knownSignature }) + "\n");
  process.exitCode = 1;
}).finally(() => clearTimeout(lifetime));
