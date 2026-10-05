import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { EvmTerms, FinalizedCancellationRequest } from "../source-order.ts";
import type { TerminalObservationResult } from "../terminal-observation.ts";
import type { BuildAcceptCancelledInstructionInput } from "../cancelled-delivery.ts";
const { buildAcceptCancelledInstruction } = await import(new URL("../cancelled-delivery.ts", import.meta.url).href) as typeof import("../cancelled-delivery.ts");
const { readFinalizedCancellationRequest, SourceOrderError } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { observeTerminalOutcome } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { AnchorProvider, BN, BorshInstructionCoder, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-cancelled-delivery.sh with all stages on the same owned nodes");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const raw = (value: string) => {
  assert.match(value, /^0x(?:[0-9a-f]{2})+$/); return Buffer.from(value.slice(2), "hex");
};
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest();
const uint = (value: bigint, width: number, little = false) => {
  assert.ok(value >= 0n && value < (1n << BigInt(width * 8)));
  const result = Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex"); return little ? result.reverse() : result;
};
const disc = (name: string) => sha(Buffer.from(name)).subarray(0, 8);
function publicValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(publicValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicValue(v)]));
  return value;
}
const stringify = (value: unknown) => JSON.stringify(publicValue(value), (_, v: unknown) => typeof v === "bigint" ? v.toString() : v, 2);
function equalPublic(actual: unknown, expected: unknown) { assert.deepEqual(JSON.parse(stringify(actual)), JSON.parse(stringify(expected))); }
function integer(value: unknown): bigint {
  assert.equal(typeof value, "string"); assert.match(value as string, /^(0|[1-9][0-9]*)$/); return BigInt(value as string);
}
function slot(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0); return value;
}
function restoreTerms(value: EvmTerms): EvmTerms {
  const terms = structuredClone(value);
  terms.identity.domain.chainId = integer(terms.identity.domain.chainId);
  terms.identity.nonce = integer(terms.identity.nonce);
  terms.cashAmount = integer(terms.cashAmount); terms.minimumShares = integer(terms.minimumShares);
  return terms;
}
// Credentials are never included in public snapshots or evidence. The original
// user credential is never read: only the operator signs receipt delivery.
function credential(name: "operator" | "initializer", identity: string) {
  const path = join(runtime, "credentials", `${name}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  assert.equal(key.publicKey.toBase58(), identity); return key;
}
function safeLamports(value: number): bigint {
  assert.ok(Number.isSafeInteger(value) && value >= 0); return BigInt(value);
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  assert.ok(info);
  return { address: key.toBase58(), account: { owner: info.owner.toBase58(), executable: info.executable,
    lamports: safeLamports(info.lamports), space: info.data.length, dataHex: info.data.toString("hex") } };
}
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;

test("fresh confirmed Cancelled delivery refunds the original source user exactly once", { timeout: 550_000 }, async (t) => {
  let constructing = false, constructionActivity = 0;
  const rejectConstruction = (method: string) => {
    if (constructing) { constructionActivity++; assert.fail(`Pure builder attempted ${method}`); }
  };
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  const evmCalls: string[] = [];
  const readMethods = ["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_call", "eth_getBlockByNumber",
    "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "eth_getBalance", "eth_getTransactionCount"];
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    rejectConstruction(`EVM RPC ${method}`);
    assert.ok(readMethods.includes(method), `This phase permits only EVM reads: ${method}`);
    evmCalls.push(method); return send(method, params);
  };
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      rejectConstruction("source RPC transport");
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  // Guard methods as well as transports, so even a cached RPC/signing/submission
  // request during construction fails before it can return or reach a network.
  const guardedConnectionMethods = [...new Set([...Object.getOwnPropertyNames(Connection.prototype), ...Object.keys(connection)])]
    .filter((name) => /^(get|send|request|confirm|simulate|_rpc)/.test(name) && typeof Reflect.get(connection, name) === "function");
  for (const name of guardedConnectionMethods) {
    const original = Reflect.get(connection, name) as (...args: unknown[]) => unknown;
    Object.defineProperty(connection, name, { configurable: true, value: (...args: unknown[]) => {
      rejectConstruction(`connection.${name}`); return original.apply(connection, args);
    } });
  }
  const evidence: { scope: string; checks: string[]; stages: Record<string, unknown>; limitations: string[]; failure?: string } = {
    scope: "One local source cancellation, confirmed EVM Cancelled, operator-attested source refund and explicit identical receipt replay on the same deployments.",
    checks: [], stages: {}, limitations: [
      "Explicitly trusted operator and RPC model; a source signature attests EVM evidence and is not a cryptographic cross-chain proof or trustless refund.",
      "Local finalized Solana and successful canonical EVM receipt/matching terminal storage with at least two additional blocks; no production bridge/finality.",
      "Existing Agave 4.1.2 SIMD-0500 genesis exception remains; see runner/setup evidence.",
      "One explicit receipt replay; no automatic resubmission, race coverage or restart recovery.",
    ],
  };
  const persist = () => writeFileSync(join(runtime, "cancelled-delivery-live-evidence.json"), stringify(evidence) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  try {
    const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
    const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
    const setup = json("agreement-evidence.json");
    const preceding = json("cancellation-forwarding-live-evidence.json");
    await check("validate successful public prerequisite evidence and original submission identities", async () => {
      assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0); assert.ok(setup.observed.agreement);
      assert.equal(preceding.failure, undefined); assert.equal(preceding.checks.length, 15);
      assert.equal(new Set(preceding.checks).size, 15);
      const stages = preceding.stages;
      assert.deepEqual(stages.selectedInputs.deployment, { evm, source });
      assert.deepEqual(stages.setupAgreement, setup.observed.agreement);
      for (const [name, event] of [["creation", "orderCreated"], ["cancellation", "cancellationRequested"]]) {
        const record = stages[name]; slot(record.finalizedSlot);
        assert.equal(record.status.confirmationStatus, "finalized"); assert.equal(record.status.err, null);
        assert.equal(record.status.slot, record.finalizedSlot); assert.equal(record.metaError, null);
        assert.deepEqual(record.requiredSigners, [stages.selectedInputs.user]);
        assert.deepEqual(record.events, [event]); assert.ok(record.signature);
      }
      assert.ok(stages.cancellation.finalizedSlot > stages.creation.finalizedSlot);
      assert.equal(stages.forwarding.submission.transactionHash, stages.forwarding.after.transactionHash);
      assert.notEqual(stages.forwarding.submission.transactionHash, stages.replay.submission.transactionHash);
      assert.equal(stages.forwarding.after.receipt.status, "0x1");
      assert.equal(stages.replay.after.receipt.status, "0x1"); assert.equal(stages.lateExecution.receipt.status, "0x0");
      assert.equal(stages.finalBoundary.sourceState, "CancelRequested"); assert.equal(stages.finalBoundary.acceptedReceipt, null);
      assert.equal(integer(stages.finalBoundary.lockedDeposit), 10_000_000n);
      assert.equal(integer(stages.finalBoundary.sourceRefunds), 0n); assert.equal(stages.finalBoundary.receiptsDelivered, 0);
      assert.equal(stages.cancelledAtNPlus2.decision.kind, "Confirmed");
      assert.equal(stages.cancelledAtNPlus2.decision.receipt.terminal, 2);
      evidence.stages.prerequisites = { setup: "agreement-evidence.json", cancellation: "cancellation-forwarding-live-evidence.json",
        cleanup: "runner-evidence.json", setupChecks: setup.checks.length, cancellationChecks: preceding.checks.length };
    });
    const selected = preceding.stages.selectedInputs;
    const creation = preceding.stages.creation, cancellation = preceding.stages.cancellation;
    const originalHash: string = preceding.stages.forwarding.submission.transactionHash;
    const user = new PublicKey(selected.user), nonce = integer(selected.nonce);
    const expectedTerms = restoreTerms(preceding.stages.forwarding.submission.sourceRequest.terms);
    assert.equal(expectedTerms.identity.nonce, nonce); assert.equal(expectedTerms.identity.user, hex(user.toBytes()));
    assert.equal(expectedTerms.cashAmount, integer(selected.cashAmount)); assert.equal(expectedTerms.cashAmount, 10_000_000n);
    assert.equal(expectedTerms.minimumShares, integer(selected.minimumShares)); assert.equal(expectedTerms.minimumShares, 20_000_000n);
    const operator = credential("operator", source.roles.operator);
    const wallet = new Wallet(operator);
    const forbiddenWallet = async () => { constructionActivity++; assert.fail("Builder must not sign or submit"); };
    wallet.signTransaction = forbiddenWallet; wallet.signAllTransactions = forbiddenWallet;
    const anchorProvider = new AnchorProvider(connection, wallet, { commitment: "finalized" });
    anchorProvider.sendAndConfirm = forbiddenWallet; anchorProvider.sendAll = forbiddenWallet; anchorProvider.simulate = forbiddenWallet;
    const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
    const program = new Program<SettlementLab>(idl, anchorProvider), programId = program.programId;
    assert.equal(programId.toBase58(), source.programId);
    const parser = new EventParser(programId, program.coder);
    const names = ["config", "accounting", "userNonce", "order", "cashMint", "yesMint", "executorCashAta", "userCashAta", "userYesAta", "escrow", "user"] as const;
    assert.deepEqual(Object.keys(selected.accounts).sort(), [...names].sort());
    const keys = Object.fromEntries(names.map((name) => [name, new PublicKey(selected.accounts[name])])) as Record<typeof names[number], PublicKey>;
    assert.ok(keys.user.equals(user));
    let latestSlot = slot(cancellation.finalizedSlot);
    let live: LiveConfigurationObservation, sourceRequest: FinalizedCancellationRequest;
    let confirmed: Extract<TerminalObservationResult, { kind: "Confirmed" }>;
    let independent: { id: Buffer; hash: Buffer; receipt: Buffer };
    const input = (): BuildAcceptCancelledInstructionInput => ({ program, expectedConfiguration: live, sourceRequest, observation: confirmed });
    async function build() {
      constructing = true;
      try { return await buildAcceptCancelledInstruction(input()); } finally { constructing = false; }
    }
    async function snapshot() {
      const response = await connection.getMultipleAccountsInfoAndContext(names.map((name) => keys[name]), {
        commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(response.context.slot >= latestSlot);
      const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
      assert.ok(protocol.context.slot >= response.context.slot);
      const tokens = [];
      for (const [mintKey, index] of [[keys.cashMint, 4], [keys.yesMint, 5]] as const) {
        const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, { commitment: "finalized", minContextSlot: response.context.slot,
          filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mintKey.toBase58() } }] });
        assert.ok(response.value[index]);
        const supply = unpackMint(mintKey, response.value[index], TOKEN_PROGRAM_ID).supply;
        const balances = accounts.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), amount: unpackAccount(pubkey, account, TOKEN_PROGRAM_ID).amount }))
          .sort((a, b) => a.address.localeCompare(b.address));
        assert.equal(balances.reduce((sum, item) => sum + item.amount, 0n), supply);
        tokens.push({ mint: mintKey.toBase58(), supply, balances,
          accounts: accounts.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)) });
      }
      const signatures = (await connection.getSignaturesForAddress(programId, { limit: 100 }, "finalized"))
        .map(({ signature, slot, err, confirmationStatus }) => ({ signature, slot, err, confirmationStatus }));
      const payer = await connection.getAccountInfoAndContext(operator.publicKey, { commitment: "finalized", minContextSlot: response.context.slot });
      assert.ok(payer.context.slot >= response.context.slot);
      return { contextSlot: response.context.slot, protocolContextSlot: protocol.context.slot,
        state: { accounts: response.value.map((info, i) => publicAccount(keys[names[i]], info)), tokens,
          protocolAccounts: protocol.value.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)), signatures },
        feePayerContextSlot: payer.context.slot, feePayer: payer.value ? publicAccount(operator.publicKey, payer.value) : null };
    }
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    function economics(s: Snapshot) {
      const data = (index: number) => Buffer.from(s.state.accounts[index].account.dataHex, "hex");
      const counters = Array.from({ length: 4 }, (_, i) => data(1).readBigUInt64LE(40 + i * 16) + (data(1).readBigUInt64LE(48 + i * 16) << 64n));
      return { userCash: data(7).readBigUInt64LE(64), escrow: data(9).readBigUInt64LE(64), cashSupply: data(4).readBigUInt64LE(36),
        userYes: data(8).readBigUInt64LE(64), yesSupply: data(5).readBigUInt64LE(36), executorCash: data(6).readBigUInt64LE(64), counters };
    }
    const lockedEconomics = { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
      userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] };
    const refundedEconomics = { ...lockedEconomics, userCash: 25_000_000n, escrow: 0n, counters: [10_000_000n, 10_000_000n, 0n, 0n] };
    const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
    const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider), yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
    async function evmSnapshot() {
      const number = BigInt(await provider.send("eth_blockNumber", [])), blockTag = toQuantity(number);
      const block = await provider.send("eth_getBlockByNumber", [blockTag, false]); assert.ok(block);
      const read = (c: Contract, name: string, ...args: unknown[]) => c.getFunction(name).staticCall(...args, { blockTag });
      const balances: Record<string, { supply: bigint; holders: Record<string, bigint> }> = {};
      for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
        const holders: Record<string, bigint> = {};
        for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
          holders[role] = await read(token, "balanceOf", address);
        }
        const supply: bigint = await read(token, "totalSupply"); assert.equal(Object.values(holders).reduce((sum, b) => sum + b, 0n), supply);
        balances[label] = { supply, holders };
      }
      const record = await read(settlement, "orderRecord", selected.independentHashes.orderId), d = record.terms.identity.domain;
      assert.equal(record.status, 2n); assert.equal(record.filledQuantity, 0n);
      assert.equal(record.termsHash, selected.independentHashes.termsHash); assert.equal(record.receiptHash, selected.independentHashes.receiptHash);
      assert.equal(settlement.interface.encodeFunctionData("cancel", [selected.independentHashes.orderId, record.terms]),
        settlement.interface.encodeFunctionData("cancel", [selected.independentHashes.orderId, expectedTerms]));
      const storedTerms = { identity: { domain: { sourceDomain: d.sourceDomain, destinationDomain: d.destinationDomain, solanaProgram: d.solanaProgram,
        chainId: d.chainId, settlement: d.settlement.toLowerCase() }, user: record.terms.identity.user, nonce: record.terms.identity.nonce },
        market: record.terms.market, outcome: Number(record.terms.outcome), cashAmount: record.terms.cashAmount, minimumShares: record.terms.minimumShares };
      const state = { balances, executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement),
        venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue), totalCashSpent: await read(settlement, "totalCashSpent"),
        totalSharesPurchased: await read(settlement, "totalSharesPurchased"), record: { terms: storedTerms, termsHash: record.termsHash,
          status: record.status, filledQuantity: record.filledQuantity, receiptHash: record.receiptHash } };
      const events = await provider.send("eth_getLogs", [{ address: evm.contracts.settlement, fromBlock: "0x0", toBlock: blockTag,
        topics: [settlement.interface.getEvent("TerminalRecorded")!.topicHash] }]);
      assert.equal(events.length, 1); assert.equal(events[0].transactionHash, originalHash);
      const native: Record<string, { balance: bigint; nonce: bigint }> = {};
      for (const role of ["operator", "executor"] as const) native[role] = {
        balance: BigInt(await provider.send("eth_getBalance", [evm.roles[role], blockTag])),
        nonce: BigInt(await provider.send("eth_getTransactionCount", [evm.roles[role], blockTag])) };
      assert.equal((await provider.send("eth_getBlockByNumber", ["latest", false])).hash, block.hash);
      return { blockNumber: number, blockHash: block.hash, state,
        recordAbi: settlement.interface.encodeFunctionResult("orderRecord", [record]), native, terminalEvents: events };
    }
    async function submit(instruction: TransactionInstruction, payer: Keypair) {
      const block = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ ...block, feePayer: payer.publicKey }).add(instruction); tx.sign(payer);
      const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "finalized", maxRetries: 0 });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (status?.confirmationStatus === "finalized") {
          assert.equal(status.err, null);
          const record = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
          assert.ok(record?.meta); assert.equal(record.meta.err, null); assert.equal(record.slot, status.slot);
          latestSlot = Math.max(latestSlot, record.slot);
          const message = record.transaction.message;
          assert.equal(message.header.numRequiredSignatures, 1);
          assert.deepEqual(message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()), [payer.publicKey.toBase58()]);
          const instructions = message.compiledInstructions.map((ix) => ({ program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
            accounts: ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), dataHex: Buffer.from(ix.data).toString("hex") }));
          assert.deepEqual(instructions, [{ program: instruction.programId.toBase58(), accounts: instruction.keys.map((meta) => meta.pubkey.toBase58()),
            dataHex: instruction.data.toString("hex") }]);
          const inner = (record.meta.innerInstructions ?? []).flatMap((group) => group.instructions.map((ix) => ({ parentIndex: group.index,
            program: message.staticAccountKeys[ix.programIdIndex].toBase58(), accounts: ix.accounts.map((index) => message.staticAccountKeys[index].toBase58()),
            dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex") })));
          const fee = safeLamports(record.meta.fee);
          // Genesis initializer balances are deliberately never converted to bigint
          // from unsafe RPC Numbers; only the small operator balance is compared.
          const payerBalances = payer.publicKey.equals(operator.publicKey)
            ? { before: safeLamports(record.meta.preBalances[0]), after: safeLamports(record.meta.postBalances[0]) }
            : { comparison: "Excluded: large genesis initializer balance is not narrowed or compared" };
          return { signature, finalizedSlot: record.slot, confirmationStatus: status.confirmationStatus, err: record.meta.err,
            requiredSigners: [payer.publicKey.toBase58()], instructions, inner, events: [...parser.parseLogs(record.meta.logMessages ?? [])],
            logs: record.meta.logMessages, fee, payerBalances, transaction: { message: message.serialize().toString("base64"),
              preTokenBalances: record.meta.preTokenBalances, postTokenBalances: record.meta.postTokenBalances }, automaticResubmissions: 0 };
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error(`Finalization deadline exceeded; no automatic resubmission: ${signature}`);
    }
    let before: Snapshot, after: Snapshot, destination: Awaited<ReturnType<typeof evmSnapshot>>, instruction: TransactionInstruction;
    await check("reverify shared live configuration and finalized original-user creation/cancellation transactions", async () => {
      live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: latestSlot });
      assert.equal(live.solana.config.dataHex, setup.observed.agreement.solana.config.dataHex);
      assert.deepEqual(live.evm.configuration, setup.observed.agreement.evm.configuration);
      assert.ok(keys.config.equals(new PublicKey(source.accounts.config))); assert.ok(keys.accounting.equals(new PublicKey(source.accounts.accounting)));
      assert.ok(keys.cashMint.equals(new PublicKey(source.mints.cash))); assert.ok(keys.yesMint.equals(new PublicKey(source.mints.yes)));
      assert.ok(keys.executorCashAta.equals(new PublicKey(source.accounts.executorCashAta)));
      for (const [mint, ata] of [[keys.cashMint, keys.userCashAta], [keys.yesMint, keys.userYesAta]] as const) {
        assert.ok(getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID).equals(ata));
      }
      for (const prior of [creation, cancellation]) {
        const status = (await connection.getSignatureStatuses([prior.signature], { searchTransactionHistory: true })).value[0];
        assert.ok(status); assert.equal(status.confirmationStatus, "finalized"); assert.equal(status.err, null); assert.equal(status.slot, prior.finalizedSlot);
        const record = await connection.getTransaction(prior.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(record?.meta); assert.equal(record.meta.err, null); assert.equal(record.slot, prior.finalizedSlot);
        const message = record.transaction.message;
        assert.deepEqual(message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()), [user.toBase58()]);
        equalPublic([...parser.parseLogs(record.meta.logMessages ?? [])], prior.eventData);
        equalPublic(message.compiledInstructions.map((ix) => ({ program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
          accounts: ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), dataHex: Buffer.from(ix.data).toString("hex") })), prior.instructions);
      }
      evidence.stages.liveConfiguration = live;
      evidence.stages.identifiers = { user: user.toBase58(), nonce, accounts: selected.accounts, terms: expectedTerms,
        creationSignature: creation.signature, creationSlot: creation.finalizedSlot, cancellationSignature: cancellation.signature,
        cancellationSlot: latestSlot, originalCancellationHash: originalHash, destinationReplayHash: preceding.stages.replay.submission.transactionHash };
      destination = await evmSnapshot();
      const priorDestination = preceding.stages.finalBoundary.evm;
      assert.equal(destination.blockNumber, BigInt(slot(priorDestination.blockNumber)));
      assert.equal(destination.blockHash, priorDestination.blockHash); equalPublic(destination.state, priorDestination.state);
      assert.equal(destination.recordAbi, preceding.stages.finalBoundary.permanentCancelled);
      const priorEvents = preceding.stages.finalBoundary.terminalEvents;
      assert.equal(priorEvents.length, 1);
      const previousEvent = priorEvents[0], freshEvent = destination.terminalEvents[0];
      assert.equal(freshEvent.address, previousEvent.address.toLowerCase());
      for (const field of ["transactionHash", "blockHash", "data", "topics", "removed"]) assert.deepEqual(freshEvent[field], previousEvent[field]);
      assert.equal(BigInt(freshEvent.blockNumber), BigInt(slot(previousEvent.blockNumber)));
      for (const [rpcField, savedField] of [["logIndex", "index"], ["transactionIndex", "transactionIndex"]]) {
        assert.ok(Number.isSafeInteger(previousEvent[savedField]) && previousEvent[savedField] >= 0);
        assert.equal(BigInt(freshEvent[rpcField]), BigInt(previousEvent[savedField]));
      }
      const terminalEvent = settlement.interface.parseLog(freshEvent); assert.ok(terminalEvent);
      assert.equal(terminalEvent.name, "TerminalRecorded");
      assert.deepEqual(Array.from(terminalEvent.args), [selected.independentHashes.orderId, selected.independentHashes.termsHash,
        2n, 0n, selected.independentHashes.receiptHash]);
      assert.equal(destination.native.operator.balance, integer(preceding.stages.wrongSigner.nativeAfter[0]));
      assert.equal(destination.native.executor.balance, integer(preceding.stages.wrongSigner.nativeAfter[1]));
      assert.equal(destination.native.operator.nonce, BigInt(preceding.stages.wrongSigner.nonceAfter[0]));
      assert.equal(destination.native.executor.nonce, BigInt(preceding.stages.wrongSigner.nonceAfter[1]));
      evidence.stages.destinationBeforeDelivery = destination;
    });
    await check("fresh finalized cancellation reader recovers the same complete original request", async () => {
      sourceRequest = await readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: latestSlot });
      assert.ok(sourceRequest.contextSlot >= cancellation.finalizedSlot);
      assert.equal(sourceRequest.state, "CancelRequested"); assert.equal(sourceRequest.cancellationRequested, true);
      assert.deepEqual(sourceRequest.terms, expectedTerms); assert.equal(sourceRequest.escrowBalance, 10_000_000n);
      assert.deepEqual(sourceRequest.accounts, Object.fromEntries(["config", "userNonce", "order", "escrow", "userCashAta", "userYesAta"].map((name) => [name, selected.accounts[name]])));
      const current = await snapshot(); equalPublic(current.state, preceding.stages.finalBoundary.sourceAfter.state);
      assert.deepEqual(economics(current), lockedEconomics);
      evidence.stages.originalValidSourceRequest = sourceRequest; evidence.stages.sourceBeforeFunding = current;
    });
    await check("rehash saved independent SPEC preimages and freshly confirm the FIRST cancellation hash at canonical N+2 or later", async () => {
      const d = expectedTerms.identity.domain;
      const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), programId.toBuffer(), uint(d.chainId, 32), raw(d.settlement)]);
      const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]), id = sha(identityPreimage);
      const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, id, user.toBuffer(), uint(nonce, 8), raw(expectedTerms.market),
        Buffer.from([0]), uint(expectedTerms.cashAmount, 8), uint(expectedTerms.minimumShares, 8)]), hash = sha(termsPreimage);
      const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), hash, Buffer.from([2]), uint(0n, 8)]), receipt = sha(receiptPreimage);
      assert.deepEqual([domain.length, identityPreimage.length, termsPreimage.length, receiptPreimage.length], [148, 196, 277, 49]);
      assert.equal(hex(domain), selected.domainPreimage);
      const saved = selected.independentHashes;
      for (const [name, preimage, expected] of [["identityPreimage", identityPreimage, saved.orderId], ["termsPreimage", termsPreimage, saved.termsHash],
        ["receiptPreimage", receiptPreimage, saved.receiptHash]] as const) {
        assert.deepEqual(raw(saved[name]), preimage); assert.equal(hex(sha(raw(saved[name]))), expected);
      }
      independent = { id, hash, receipt };
      assert.equal(sourceRequest.orderId, hex(id)); assert.equal(sourceRequest.termsHash, hex(hash));
      const observed = await observeTerminalOutcome({ provider, expectedConfiguration: live, orderId: sourceRequest.orderId,
        termsHash: sourceRequest.termsHash, terms: sourceRequest.terms, transactionHash: originalHash });
      assert.equal(observed.kind, "Confirmed"); assert.ok(observed.kind === "Confirmed"); confirmed = observed;
      assert.equal(confirmed.transactionHash, originalHash); assert.equal(confirmed.orderId, hex(id)); assert.equal(confirmed.termsHash, hex(hash));
      assert.deepEqual(confirmed.terms, expectedTerms); assert.deepEqual(confirmed.receipt, { termsHash: sourceRequest.termsHash, terminal: 2, filledQuantity: 0n });
      assert.equal(confirmed.receiptHash, hex(receipt)); assert.ok(confirmed.additionalBlocks >= 2n);
      assert.equal(confirmed.additionalBlocks, confirmed.observationHead.number - confirmed.inclusion.number);
      for (const b of [confirmed.inclusion, confirmed.observationHead]) {
        const canonical = await provider.send("eth_getBlockByNumber", [toQuantity(b.number), false]);
        assert.equal(BigInt(canonical.number), b.number); assert.equal(canonical.hash, b.hash);
      }
      const original = await provider.send("eth_getTransactionReceipt", [originalHash]); assert.equal(original.status, "0x1");
      assert.equal(BigInt(original.blockNumber), confirmed.inclusion.number); assert.equal(original.blockHash, confirmed.inclusion.hash);
      assert.equal(confirmed.observationHead.hash, destination.blockHash);
      evidence.stages.independentHashes = { ...saved, rehashed: { orderId: hex(id), termsHash: hex(hash), receiptHash: hex(receipt) } };
      evidence.stages.freshTerminalObservation = confirmed;
    });
    await check("pure actual Cancelled builder matches independent Borsh bytes, complete IDL arguments and all ten account metas", async () => {
      instruction = await build(); assert.equal(constructionActivity, 0);
      const d = expectedTerms.identity.domain;
      const expectedBytes = Buffer.concat([disc("global:accept_cancelled"), raw(d.sourceDomain), raw(d.destinationDomain), programId.toBuffer(),
        uint(d.chainId, 32), raw(d.settlement), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market), Buffer.from([0]),
        uint(expectedTerms.cashAmount, 8, true), uint(expectedTerms.minimumShares, 8, true), independent.hash, Buffer.from([2]), uint(0n, 8, true)]);
      assert.ok(instruction.programId.equals(programId)); assert.deepEqual(instruction.data, expectedBytes);
      const idlInstruction = program.idl.instructions.find((ix) => ix.name === "acceptCancelled"); assert.ok(idlInstruction);
      assert.deepEqual(idlInstruction.discriminator, [...disc("global:accept_cancelled")]);
      const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data); assert.ok(decoded); assert.equal(decoded.name, "acceptCancelled");
      equalPublic(decoded.data, { args: { terms: { domain: { sourceDomain: [...raw(d.sourceDomain)], destinationDomain: [...raw(d.destinationDomain)],
        solanaProgram: programId, chainId: [...uint(d.chainId, 32)], settlement: [...raw(d.settlement)] }, user, nonce: new BN(nonce.toString()),
        market: [...raw(expectedTerms.market)], outcome: 0, cashAmount: new BN(expectedTerms.cashAmount.toString()), minimumShares: new BN(expectedTerms.minimumShares.toString()) },
        receipt: { termsHash: [...independent.hash], terminal: 2, filledQuantity: new BN("0") } } });
      const accountKeys = [operator.publicKey, user, keys.config, keys.accounting, keys.userNonce, keys.order, keys.cashMint, keys.userCashAta, keys.escrow, TOKEN_PROGRAM_ID];
      const writable = [3, 5, 7, 8];
      assert.deepEqual(instruction.keys, accountKeys.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: writable.includes(i) })));
      assert.deepEqual(idlInstruction.accounts.map((a) => ({ name: a.name, signer: "signer" in a && a.signer === true, writable: "writable" in a && a.writable === true })),
        ["operator", "user", "config", "accounting", "userNonce", "order", "cashMint", "userCashAta", "escrow", "tokenProgram"]
          .map((name, i) => ({ name, signer: i === 0, writable: writable.includes(i) })));
      assert.ok(!instruction.keys.some((a) => [keys.userYesAta, keys.yesMint, keys.executorCashAta].some((key) => a.pubkey.equals(key))));
      evidence.stages.instruction = { dataHex: instruction.data.toString("hex"), independentDataHex: expectedBytes.toString("hex"), decoded,
        accounts: instruction.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })),
        guardedConnectionMethods, rpcSigningSubmissionActivity: constructionActivity };
    });
    await check("explicit fixture funds only a small operator fee balance and snapshots source after funding", async () => {
      const initializer = credential("initializer", source.roles.initializer);
      const prior = await snapshot(); assert.ok(prior.feePayer === null || prior.feePayer.account.lamports === 0n);
      const funding = await submit(SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: operator.publicKey, lamports: 2_000_000 }), initializer);
      assert.deepEqual(funding.events, []); assert.deepEqual(funding.inner, []);
      before = await snapshot(); assert.ok(before.feePayer); assert.equal(before.feePayer.account.lamports, 2_000_000n);
      assert.equal(before.feePayer.account.owner, SystemProgram.programId.toBase58()); assert.equal(before.feePayer.account.space, 0);
      assert.deepEqual(before.state, prior.state); assert.deepEqual(economics(before), lockedEconomics);
      equalPublic(before.state, preceding.stages.finalBoundary.sourceAfter.state);
      const order = program.coder.accounts.decode("order", Buffer.from(before.state.accounts[3].account.dataHex, "hex"));
      assert.deepEqual(order.state, { cancelRequested: {} }); assert.equal(order.cancellationRequested, true); assert.equal(order.acceptedReceipt, null);
      const [orderKey, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
      const [escrowKey, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), orderKey.toBuffer()], programId);
      assert.ok(orderKey.equals(keys.order) && escrowKey.equals(keys.escrow));
      const expectedPending = Buffer.concat([disc("account:Order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market),
        Buffer.from([0]), uint(expectedTerms.cashAmount, 8, true), uint(expectedTerms.minimumShares, 8, true), independent.id, independent.hash,
        keys.userCashAta.toBuffer(), keys.userYesAta.toBuffer(), keys.escrow.toBuffer(), Buffer.from([1, 1, 0, orderBump, escrowBump]), Buffer.alloc(41)]);
      assert.equal(before.state.accounts[3].account.dataHex, expectedPending.toString("hex"));
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.feeFunding = { ...funding, fundedLamports: 2_000_000n, credentialUsedOnlyForFixture: "initializer",
        initializerBalanceComparison: "Excluded: large genesis balance is not narrowed or compared" };
      evidence.stages.beforeDelivery = { source: before, decodedOrder: order, economics: economics(before), evm: destination };
    });
    await check("real operator-only finalized refund emits one CancelledAccepted and exactly one escrow-to-original-user TransferChecked", async () => {
      const delivery = await submit(instruction, operator);
      assert.ok(delivery.finalizedSlot > cancellation.finalizedSlot);
      equalPublic(delivery.events, [{ name: "cancelledAccepted", data: { order: keys.order, termsHash: [...independent.hash],
        receiptHash: [...independent.receipt], cashAmount: new BN("10000000") } }]);
      assert.deepEqual(delivery.inner, [{ parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(),
        accounts: [keys.escrow, keys.cashMint, keys.userCashAta, keys.order].map((key) => key.toBase58()),
        dataHex: Buffer.concat([Buffer.from([12]), uint(10_000_000n, 8, true), Buffer.from([6])]).toString("hex") }]);
      assert.deepEqual(delivery.logs?.filter((line) => /^Program .* invoke/.test(line)),
        [`Program ${programId.toBase58()} invoke [1]`, `Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`]);
      after = await snapshot(); assert.ok(after.contextSlot >= delivery.finalizedSlot); assert.deepEqual(economics(after), refundedEconomics);
      const [orderKey, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8)], programId);
      const [, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), orderKey.toBuffer()], programId);
      // Independent complete terminal Borsh bytes: state, retained cancellation,
      // Option::Some, terminal, quantity, receipt hash, then both moved bumps.
      const terminalBytes = Buffer.concat([disc("account:Order"), keys.config.toBuffer(), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market),
        Buffer.from([0]), uint(expectedTerms.cashAmount, 8, true), uint(expectedTerms.minimumShares, 8, true), independent.id, independent.hash,
        keys.userCashAta.toBuffer(), keys.userYesAta.toBuffer(), keys.escrow.toBuffer(), Buffer.from([3, 1, 1, 2]), uint(0n, 8, true),
        independent.receipt, Buffer.from([orderBump, escrowBump])]);
      const [, accountingBump] = PublicKey.findProgramAddressSync([Buffer.from("accounting"), keys.config.toBuffer()], programId);
      const accountingBytes = Buffer.concat([disc("account:Accounting"), keys.config.toBuffer(), ...[10_000_000n, 10_000_000n, 0n, 0n].map((n) => uint(n, 16, true)),
        Buffer.from([accountingBump])]);
      assert.equal(terminalBytes.length, 335); assert.equal(accountingBytes.length, 105);
      assert.equal(after.state.accounts[3].account.dataHex, terminalBytes.toString("hex"));
      assert.equal(after.state.accounts[1].account.dataHex, accountingBytes.toString("hex"));
      const oldOrder = program.coder.accounts.decode("order", Buffer.from(before.state.accounts[3].account.dataHex, "hex"));
      const newOrder = program.coder.accounts.decode("order", Buffer.from(after.state.accounts[3].account.dataHex, "hex"));
      equalPublic(newOrder, { ...oldOrder, state: { refunded: {} }, acceptedReceipt: { terminal: 2, filledQuantity: new BN("0"), receiptHash: [...independent.receipt] } });
      const oldAccounting = program.coder.accounts.decode("accounting", Buffer.from(before.state.accounts[1].account.dataHex, "hex"));
      const newAccounting = program.coder.accounts.decode("accounting", Buffer.from(after.state.accounts[1].account.dataHex, "hex"));
      equalPublic(newAccounting, { ...oldAccounting, totalRefunded: new BN("10000000") });
      const expected = structuredClone(before.state);
      expected.accounts[3].account.dataHex = terminalBytes.toString("hex"); expected.accounts[1].account.dataHex = accountingBytes.toString("hex");
      for (const [index, amount] of [[7, 25_000_000n], [9, 0n]] as const) {
        const data = Buffer.from(expected.accounts[index].account.dataHex, "hex"); data.writeBigUInt64LE(amount, 64);
        expected.accounts[index].account.dataHex = data.toString("hex");
      }
      const replacement = (address: string) => expected.accounts.find((a) => a.address === address)!.account.dataHex;
      for (const record of expected.protocolAccounts) record.account.dataHex = replacement(record.address);
      for (const mint of expected.tokens) {
        for (const record of mint.accounts) record.account.dataHex = replacement(record.address);
        for (const balance of mint.balances) balance.amount = Buffer.from(replacement(balance.address), "hex").readBigUInt64LE(64);
      }
      expected.signatures.unshift({ signature: delivery.signature, slot: delivery.finalizedSlot, err: null, confirmationStatus: "finalized" });
      assert.deepEqual(after.state, expected, "Complete account bytes, rent, immutable records, all fixture tokens and program history");
      assert.ok(before.feePayer && after.feePayer);
      assert.deepEqual(after.feePayer, { ...before.feePayer, account: { ...before.feePayer.account, lamports: before.feePayer.account.lamports - delivery.fee } });
      assert.deepEqual(delivery.payerBalances, { before: before.feePayer.account.lamports, after: after.feePayer.account.lamports });
      assert.deepEqual(await evmSnapshot(), destination, "Complete destination state, native nonces/balances, event history and block identity unchanged");
      evidence.stages.delivery = { ...delivery, source: after, economics: economics(after), decodedOrder: newOrder, decodedAccounting: newAccounting,
        independentOrderHex: terminalBytes.toString("hex"), independentAccountingHex: accountingBytes.toString("hex"), evm: await evmSnapshot() };
    });
    await check("reconstruction from original valid builder inputs is identical after refund without a new eligibility read", async () => {
      assert.equal(sourceRequest.state, "CancelRequested"); assert.equal(sourceRequest.escrowBalance, 10_000_000n);
      const rebuilt = await build(); assert.deepEqual(rebuilt.data, instruction.data); assert.deepEqual(rebuilt.keys, instruction.keys);
      assert.ok(rebuilt.programId.equals(instruction.programId)); assert.equal(constructionActivity, 0);
      evidence.stages.reconstruction = { usedOriginalSourceSnapshot: true, identicalBytesAndMetas: true, rpcSigningSubmissionActivity: constructionActivity };
    });
    await check("one explicit identical on-chain replay finalizes with no event, no CPI and only the operator transaction fee", async () => {
      const replay = await submit(instruction, operator), delivered = evidence.stages.delivery as { signature: string };
      assert.notEqual(replay.signature, delivered.signature); assert.deepEqual(replay.events, []); assert.deepEqual(replay.inner, []);
      assert.deepEqual(replay.logs?.filter((line) => /^Program .* invoke/.test(line)), [`Program ${programId.toBase58()} invoke [1]`]);
      const final = await snapshot(); assert.ok(final.contextSlot >= replay.finalizedSlot);
      const expected = structuredClone(after.state);
      expected.signatures.unshift({ signature: replay.signature, slot: replay.finalizedSlot, err: null, confirmationStatus: "finalized" });
      assert.deepEqual(final.state, expected); assert.deepEqual(economics(final), refundedEconomics);
      assert.ok(after.feePayer && final.feePayer);
      assert.deepEqual(final.feePayer, { ...after.feePayer, account: { ...after.feePayer.account, lamports: after.feePayer.account.lamports - replay.fee } });
      assert.deepEqual(replay.payerBalances, { before: after.feePayer.account.lamports, after: final.feePayer.account.lamports });
      assert.deepEqual(await evmSnapshot(), destination);
      evidence.stages.replay = { ...replay, source: final, economics: economics(final), evm: await evmSnapshot(), additionalEconomicEffect: false };
    });
    await check("fresh Refunded reader rejects only after explicit replay; actual SPL accounts conserve both supplies and zero outstanding cash", async () => {
      await assert.rejects(readFinalizedCancellationRequest({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: latestSlot }),
        (error: unknown) => error instanceof SourceOrderError && error.code === "NotCancelRequested");
      const final = await snapshot(), e = economics(final); assert.deepEqual(e, refundedEconomics);
      const replaySource = (evidence.stages.replay as { source: Snapshot }).source;
      assert.deepEqual(final.state, replaySource.state); assert.deepEqual(final.feePayer, replaySource.feePayer);
      assert.equal(e.cashSupply, e.userCash + e.escrow + e.executorCash); assert.equal(e.yesSupply, e.userYes);
      assert.equal(e.counters[0], e.escrow + e.counters[1] + e.counters[2]); assert.equal(e.escrow, 0n);
      assert.equal(e.counters[3], 0n); assert.equal(e.yesSupply, confirmed.receipt.filledQuantity); assert.equal(destination.state.totalSharesPurchased, 0n);
      for (const [index, key, owner, amount] of [[7, keys.userCashAta, user, 25_000_000n], [8, keys.userYesAta, user, 0n],
        [6, keys.executorCashAta, new PublicKey(source.roles.executor), 0n], [9, keys.escrow, keys.order, 0n]] as const) {
        const info = final.state.accounts[index].account;
        const token = unpackAccount(key, { data: Buffer.from(info.dataHex, "hex"), owner: new PublicKey(info.owner), executable: info.executable,
          lamports: Number(info.lamports) }, TOKEN_PROGRAM_ID);
        assert.ok(token.owner.equals(owner)); assert.equal(token.amount, amount); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
      }
      const endDestination = await evmSnapshot(); assert.deepEqual(endDestination, destination); assert.equal(constructionActivity, 0);
      evidence.stages.conservation = { source: final, economics: e, mintAccounts: final.state.tokens,
        deposited: e.counters[0], outstandingCash: e.escrow, refunded: e.counters[1], reimbursed: e.counters[2], issued: e.counters[3],
        destinationQuantity: confirmed.receipt.filledQuantity, destinationYesCustody: destination.state.balances.yes.holders.settlement,
        unchangedDestination: endDestination, freshRefundedReader: "NotCancelRequested", completedLocalCancellationRefund: true,
        newEvmTransactions: 0, minedEvmBlocks: 0, evmReadCalls: evmCalls, rpcSigningSubmissionActivity: constructionActivity };
    });
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally { provider.destroy(); persist(); }
});
