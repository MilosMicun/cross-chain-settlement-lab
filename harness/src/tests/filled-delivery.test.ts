import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { EvmTerms, FinalizedPendingOrder } from "../source-order.ts";
import type { TerminalObservationResult } from "../terminal-observation.ts";
import type { BuildAcceptFilledInstructionInput } from "../filled-delivery.ts";
const { buildAcceptFilledInstruction } = await import(new URL("../filled-delivery.ts", import.meta.url).href) as typeof import("../filled-delivery.ts");
const { readFinalizedPendingOrder } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { observeTerminalOutcome } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { AnchorProvider, BN, BorshInstructionCoder, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-filled-delivery.sh after unchanged setup and forwarding stages");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const raw = (value: string) => Buffer.from(value.slice(2), "hex");
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString("hex")}`;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest();
const uint = (value: bigint, width: number, little = false) => {
  const b = Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex"); return little ? b.reverse() : b;
};
const disc = (value: string) => sha(Buffer.from(value)).subarray(0, 8);
// BN decoders may retain different internal word allocations for equal integers.
function decodedValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(decodedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodedValue(v)]));
  return value;
}
function equalDecoded(actual: unknown, expected: unknown) { assert.deepEqual(decodedValue(actual), decodedValue(expected)); }
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
function integer(value: unknown): bigint {
  assert.equal(typeof value, "string"); assert.match(value as string, /^(0|[1-9][0-9]*)$/); return BigInt(value as string);
}
function restoreTerms(value: EvmTerms): EvmTerms {
  const t = structuredClone(value);
  t.identity.domain.chainId = integer(t.identity.domain.chainId);
  t.identity.nonce = integer(t.identity.nonce); t.cashAmount = integer(t.cashAmount); t.minimumShares = integer(t.minimumShares);
  return t;
}
function credential(name: string) {
  const path = join(runtime, "credentials", `${name}.json`); assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  assert.ok(info); assert.ok(Number.isSafeInteger(info.lamports));
  return { address: key.toBase58(), owner: info.owner.toBase58(), executable: info.executable,
    lamports: BigInt(info.lamports), space: info.data.length, dataHex: info.data.toString("hex") };
}

test("confirmed real Filled receipt finalizes source issuance/reimbursement once", { timeout: 550_000 }, async (t) => {
  let constructing = false, constructionActivity = 0;
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 10_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (constructing) { constructionActivity++; assert.fail(`Instruction construction attempted EVM RPC: ${method}`); }
    return send(method, params);
  };
  const connection = new Connection("http://127.0.0.1:18899", { commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      if (constructing) { constructionActivity++; assert.fail("Instruction construction attempted source RPC"); }
      return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } });
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const setup = json("agreement-evidence.json");
  const forwarding = json("order-forwarding-evidence.json");
  assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0);
  assert.equal(forwarding.failure, undefined); assert.equal(forwarding.checks.length, 10);
  const selected = forwarding.stages.selectedInputs;
  const creation = forwarding.stages.creation;
  const purchase = forwarding.stages.purchase;
  assert.ok(Number.isSafeInteger(creation.finalizedSlot) && creation.finalizedSlot > 0);
  assert.equal(purchase.submissionHash, purchase.submission.transactionHash);
  assert.equal(purchase.receipt.status, 1);
  const user = new PublicKey(selected.user), nonce = integer(selected.nonce);
  const expectedTerms = restoreTerms(purchase.submission.sourceOrder.terms);
  const operator = credential("operator");
  assert.equal(operator.publicKey.toBase58(), source.roles.operator);
  const idl = JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")) as SettlementLab;
  const wallet = new Wallet(operator);
  wallet.signTransaction = async () => { constructionActivity++; assert.fail("Adapter must not sign"); };
  wallet.signAllTransactions = async () => { constructionActivity++; assert.fail("Adapter must not sign"); };
  const anchorProvider = new AnchorProvider(connection, wallet, { commitment: "finalized" });
  anchorProvider.sendAndConfirm = async () => { constructionActivity++; assert.fail("Adapter must not submit"); };
  const program = new Program<SettlementLab>(idl, anchorProvider);
  const programId = program.programId;
  const parser = new EventParser(programId, program.coder);
  const keys = Object.fromEntries(Object.entries(selected.accounts).map(([name, value]) => [name, new PublicKey(value as string)]));
  assert.equal(keys.user.toBase58(), user.toBase58());
  const [yesAuthority] = PublicKey.findProgramAddressSync([Buffer.from("yes-authority"), keys.config.toBuffer()], programId);
  const evidence: { scope: string; checks: string[]; stages: Record<string, unknown>; limitations: string[]; failure?: string } = {
    scope: "One real local source deposit, EVM purchase, fresh confirmed observation, source Filled delivery and exact duplicate delivery.",
    checks: [], stages: { prerequisites: { setup: "agreement-evidence.json", forwarding: "order-forwarding-evidence.json", cleanup: "runner-evidence.json" },
      identifiers: { sourceUser: selected.user, nonce, creationSignature: creation.signature, creationSlot: creation.finalizedSlot,
        originalPurchaseHash: purchase.submissionHash, destinationReplayHash: forwarding.stages.duplicate.submissionHash } },
    limitations: ["Explicitly trusted operator and RPC observations; instruction encoding cannot prove EVM execution.",
      "Local finalized Solana and successful canonical EVM receipt/storage with two additional blocks; no production finality.",
      "No cancellation forwarding/refunds across both chains, race outcomes, restart recovery or bridge.",
      "Source escrow reimbursement and executor EVM prefunding are separate cash balances.",
      "Existing Agave 4.1.2 SIMD-0500 local genesis limitation; see runner/setup evidence."],
  };
  const persist = () => writeFileSync(join(runtime, "filled-delivery-evidence.json"),
    JSON.stringify(decodedValue(evidence), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  let latestSlot = creation.finalizedSlot;
  async function snapshot() {
    const entries = Object.entries(keys);
    const response = await connection.getMultipleAccountsInfoAndContext(entries.map(([, key]) => key), {
      commitment: "finalized", minContextSlot: latestSlot });
    assert.ok(response.context.slot >= latestSlot);
    const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
    assert.ok(protocol.context.slot >= response.context.slot);
    const payer = await connection.getAccountInfoAndContext(operator.publicKey, { commitment: "finalized", minContextSlot: response.context.slot });
    assert.ok(payer.context.slot >= response.context.slot);
    return { contextSlot: response.context.slot, minContextSlot: latestSlot, protocolContextSlot: protocol.context.slot,
      records: Object.fromEntries(entries.map(([name, key], i) => [name, publicAccount(key, response.value[i])])),
      protocolAccounts: protocol.value.map((item) => publicAccount(item.pubkey, item.account)).sort((a, b) => a.address.localeCompare(b.address)),
      feePayer: publicAccount(operator.publicKey, payer.value) };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  function economics(s: Snapshot) {
    const data = (name: string) => Buffer.from(s.records[name].dataHex, "hex");
    const amount = (name: string) => data(name).readBigUInt64LE(64);
    const supply = (name: string) => data(name).readBigUInt64LE(36);
    const counters = Array.from({ length: 4 }, (_, i) => data("accounting").readBigUInt64LE(40 + i * 16)
      + (data("accounting").readBigUInt64LE(48 + i * 16) << 64n));
    return { userCash: amount("userCashAta"), escrow: amount("escrow"), executorCash: amount("executorCashAta"),
      cashSupply: supply("cashMint"), userYes: amount("userYesAta"), yesSupply: supply("yesMint"), counters };
  }
  const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
  const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider);
  const yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
  async function evmSnapshot() {
    const blockTag = toQuantity(BigInt(await provider.send("eth_blockNumber", [])));
    const read = (c: Contract, name: string, ...args: unknown[]) => c.getFunction(name).staticCall(...args, { blockTag });
    const balances: Record<string, unknown> = {};
    for (const [label, token] of [["usd", usd], ["yes", yes]] as const) {
      const holders: Record<string, bigint> = {};
      for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
        holders[role] = await read(token, "balanceOf", address);
      }
      const supply: bigint = await read(token, "totalSupply");
      assert.equal(Object.values(holders).reduce((a, b) => a + b, 0n), supply);
      balances[label] = { supply, holders };
    }
    const record = await read(settlement, "orderRecord", selected.independentHashes.orderId);
    const state = { balances, recordAbi: settlement.interface.encodeFunctionResult("orderRecord", [record]),
      executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement),
      venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue),
      totalCashSpent: await read(settlement, "totalCashSpent"), totalSharesPurchased: await read(settlement, "totalSharesPurchased"),
      operatorNative: await provider.getBalance(evm.roles.operator, blockTag), executorNative: await provider.getBalance(evm.roles.executor, blockTag),
      operatorNonce: await provider.send("eth_getTransactionCount", [evm.roles.operator, blockTag]) };
    assert.equal(record.status, 1n); assert.equal(record.filledQuantity, 20_000_000n);
    assert.equal(record.termsHash, selected.independentHashes.termsHash); assert.equal(record.receiptHash, selected.independentHashes.receiptHash);
    assert.equal(settlement.interface.encodeFunctionData("execute", [selected.independentHashes.orderId, record.terms]),
      settlement.interface.encodeFunctionData("execute", [selected.independentHashes.orderId, expectedTerms]));
    return { blockTag, blockHash: (await provider.send("eth_getBlockByNumber", [blockTag, false])).hash, state };
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
        const txRecord = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(txRecord?.meta); assert.equal(txRecord.meta.err, null); assert.equal(txRecord.slot, status.slot);
        latestSlot = Math.max(latestSlot, txRecord.slot);
        const message = txRecord.transaction.message;
        const inner = (txRecord.meta.innerInstructions ?? []).flatMap((group) => group.instructions.map((ix) => ({
          parentIndex: group.index, program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
          accounts: ix.accounts.map((index) => message.staticAccountKeys[index].toBase58()),
          dataHex: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)).toString("hex") })));
        return { signature, finalizedSlot: txRecord.slot, confirmationStatus: status.confirmationStatus,
          events: [...parser.parseLogs(txRecord.meta.logMessages ?? [])], inner, fee: BigInt(txRecord.meta.fee),
          requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()),
          logs: txRecord.meta.logMessages, transaction: { message: message.serialize().toString("base64"),
            preTokenBalances: txRecord.meta.preTokenBalances, postTokenBalances: txRecord.meta.postTokenBalances } };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Finalization deadline exceeded; no automatic resubmission: ${signature}`);
  }
  let live: LiveConfigurationObservation;
  let pending: FinalizedPendingOrder;
  let confirmed: Extract<TerminalObservationResult, { kind: "Confirmed" }>;
  let before: Snapshot, after: Snapshot, destination: Awaited<ReturnType<typeof evmSnapshot>>;
  let instruction: TransactionInstruction;
  let independent: { id: Buffer; hash: Buffer; receipt: Buffer };
  async function build(input: BuildAcceptFilledInstructionInput) {
    constructing = true;
    try { return await buildAcceptFilledInstruction(input); } finally { constructing = false; }
  }
  const input = (): BuildAcceptFilledInstructionInput => ({ program, expectedConfiguration: live, sourceOrder: pending, observation: confirmed });
  try {
    await check("recover real identifiers and re-read finalized Pending order on unchanged deployments", async () => {
      live = await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source, minFinalizedSlot: creation.finalizedSlot });
      assert.equal(live.solana.config.dataHex, setup.observed.agreement.solana.config.dataHex);
      pending = await readFinalizedPendingOrder({ connection, expectedConfiguration: live, user, nonce, minFinalizedSlot: creation.finalizedSlot });
      assert.deepEqual(pending.terms, expectedTerms); assert.deepEqual(pending.accounts, purchase.submission.sourceOrder.accounts);
      assert.equal(pending.orderId, selected.independentHashes.orderId); assert.equal(pending.termsHash, selected.independentHashes.termsHash);
      evidence.stages.sourceReader = pending; evidence.stages.liveConfiguration = live;
    });
    await check("fresh observer confirms ORIGINAL purchase with independent SHA-256 preimages", async () => {
      const observation = await observeTerminalOutcome({ provider, expectedConfiguration: live, orderId: pending.orderId,
        termsHash: pending.termsHash, terms: pending.terms, transactionHash: purchase.submissionHash });
      assert.equal(observation.kind, "Confirmed"); assert.ok(observation.kind === "Confirmed"); confirmed = observation;
      assert.equal(confirmed.transactionHash, purchase.submissionHash); assert.equal(confirmed.receipt.terminal, 1);
      const d = expectedTerms.identity.domain;
      const domain = Buffer.concat([raw(d.sourceDomain), raw(d.destinationDomain), raw(d.solanaProgram), uint(d.chainId, 32), raw(d.settlement)]);
      const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.toBuffer(), uint(nonce, 8)]);
      const id = sha(identityPreimage);
      const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, id, user.toBuffer(), uint(nonce, 8), raw(expectedTerms.market),
        Buffer.from([0]), uint(expectedTerms.cashAmount, 8), uint(expectedTerms.minimumShares, 8)]);
      const hash = sha(termsPreimage);
      const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), hash, Buffer.from([1]), uint(20_000_000n, 8)]);
      const receipt = sha(receiptPreimage); independent = { id, hash, receipt };
      assert.deepEqual([identityPreimage.length, termsPreimage.length, receiptPreimage.length], [196, 277, 49]);
      assert.equal(confirmed.orderId, hex(id)); assert.equal(confirmed.termsHash, hex(hash)); assert.equal(confirmed.receiptHash, hex(receipt));
      assert.deepEqual(confirmed.terms, pending.terms); assert.ok(confirmed.additionalBlocks >= 2n);
      evidence.stages.observation = confirmed;
      evidence.stages.independentHashes = { orderId: hex(id), termsHash: hex(hash), receiptHash: hex(receipt),
        identityPreimage: hex(identityPreimage), termsPreimage: hex(termsPreimage), receiptPreimage: hex(receiptPreimage) };
      const realReceipt = await provider.getTransactionReceipt(purchase.submissionHash); assert.ok(realReceipt); assert.equal(realReceipt.status, 1);
      evidence.stages.evmGas = { originalPurchaseGas: realReceipt.gasUsed * realReceipt.gasPrice,
        forwardingReplayGas: forwarding.stages.duplicate.gasCost, newEvmTransactions: 0 };
    });
    await check("reject malformed attestations, terms, hashes, confirmation and account bindings without activity", async () => {
      const invalid = (change: (value: BuildAcceptFilledInstructionInput) => void) => {
        const i = { ...input(), expectedConfiguration: structuredClone(live), sourceOrder: structuredClone(pending), observation: structuredClone(confirmed) } as BuildAcceptFilledInstructionInput;
        change(i); return i;
      };
      // Deliberately violate runtime types, as transport/caller input can do.
      const cases: [string, BuildAcceptFilledInstructionInput][] = [
        ["NotConfirmed", { ...input(), observation: { kind: "NotConfirmed", reason: "MissingReceipt" } }],
        ["Cancelled", invalid((i) => { (i.observation as typeof confirmed).receipt.terminal = 2; })],
        ["quantity", invalid((i) => { (i.observation as typeof confirmed).receipt.filledQuantity++; })],
        ["terms", invalid((i) => { (i.observation as typeof confirmed).terms.minimumShares++; })],
        ["terms hash", invalid((i) => { i.sourceOrder.termsHash = hex(Buffer.alloc(32)) as typeof pending.termsHash; })],
        ["order ID", invalid((i) => { (i.observation as typeof confirmed).orderId = hex(Buffer.alloc(32)) as typeof confirmed.orderId; })],
        ["receipt hash", invalid((i) => { (i.observation as typeof confirmed).receiptHash = hex(Buffer.alloc(32)) as typeof confirmed.receiptHash; })],
        ["additional blocks", invalid((i) => { (i.observation as typeof confirmed).additionalBlocks = 1n; })],
        ["block identity", invalid((i) => { (i.observation as typeof confirmed).inclusion.hash = hex(Buffer.alloc(32)) as typeof confirmed.inclusion.hash; })],
        ["source ATA", invalid((i) => { i.sourceOrder.accounts.userYesAta = keys.userCashAta.toBase58(); })],
        ["operator", invalid((i) => { i.expectedConfiguration.solana.config.operator = user.toBase58(); })],
        ["IDL program", { ...input(), program: { ...program, programId: user } as unknown as typeof program }],
        ["number amount", invalid((i) => { (i.sourceOrder.terms as unknown as { cashAmount: number }).cashAmount = 10_000_000; })],
      ];
      for (const [label, i] of cases) await assert.rejects(build(i), /./, label);
      assert.equal(constructionActivity, 0);
      evidence.stages.adapterRejections = { cases: cases.map(([name]) => name), rpcSigningSubmissionActivity: constructionActivity };
    });
    await check("actual IDL decode and independent Borsh/account encoding match pure adapter", async () => {
      instruction = await build(input()); assert.equal(constructionActivity, 0);
      const d = expectedTerms.identity.domain;
      const expectedBytes = Buffer.concat([disc("global:accept_filled"), raw(d.sourceDomain), raw(d.destinationDomain), programId.toBuffer(),
        uint(d.chainId, 32), raw(d.settlement), user.toBuffer(), uint(nonce, 8, true), raw(expectedTerms.market), Buffer.from([0]),
        uint(10_000_000n, 8, true), uint(20_000_000n, 8, true), independent.hash, Buffer.from([1]), uint(20_000_000n, 8, true)]);
      assert.deepEqual(instruction.data, expectedBytes); assert.ok(instruction.programId.equals(programId));
      const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data); assert.ok(decoded); assert.equal(decoded.name, "acceptFilled");
      equalDecoded(decoded.data, { args: { terms: { domain: { sourceDomain: [...raw(d.sourceDomain)], destinationDomain: [...raw(d.destinationDomain)],
        solanaProgram: programId, chainId: [...uint(31337n, 32)], settlement: [...raw(d.settlement)] }, user, nonce: new BN(nonce.toString()),
        market: [...raw(expectedTerms.market)], outcome: 0, cashAmount: new BN("10000000"), minimumShares: new BN("20000000") },
      receipt: { termsHash: [...independent.hash], terminal: 1, filledQuantity: new BN("20000000") } } });
      const accountKeys = [operator.publicKey, user, keys.config, keys.accounting, keys.userNonce, keys.order, keys.cashMint, keys.yesMint,
        keys.userYesAta, keys.escrow, keys.executorCashAta, yesAuthority, TOKEN_PROGRAM_ID];
      const writable = [3, 5, 7, 8, 9, 10];
      assert.deepEqual(instruction.keys, accountKeys.map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: writable.includes(index) })));
      evidence.stages.instruction = { dataHex: instruction.data.toString("hex"), independentDataHex: expectedBytes.toString("hex"),
        accounts: instruction.keys.map((a) => ({ address: a.pubkey.toBase58(), signer: a.isSigner, writable: a.isWritable })), activity: constructionActivity };
    });
    await check("fund only small operator fee balance and verify exact pre-delivery economics", async () => {
      const initializer = credential("initializer");
      const prior = await connection.getAccountInfo(operator.publicKey, { commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(prior === null || prior.lamports === 0);
      const funding = await submit(SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: operator.publicKey, lamports: 2_000_000 }), initializer);
      before = await snapshot(); assert.equal(before.feePayer.lamports, 2_000_000n);
      assert.deepEqual(economics(before), { userCash: 15_000_000n, escrow: 10_000_000n, executorCash: 0n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      const o = program.coder.accounts.decode("order", Buffer.from(before.records.order.dataHex, "hex"));
      assert.deepEqual(o.state, { pending: {} }); assert.equal(o.acceptedReceipt, null); assert.equal(o.cancellationRequested, false);
      assert.equal(before.records.config.dataHex, live.solana.config.dataHex);
      assert.equal(before.records.order.dataHex, creation.snapshot.state.accounts[3].account.dataHex);
      assert.equal(before.records.userNonce.dataHex, creation.snapshot.state.accounts[2].account.dataHex);
      destination = await evmSnapshot();
      assert.deepEqual(destination.state.balances, { usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 90_000_000n, venue: 10_000_000n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 180_000_000n, settlement: 20_000_000n } } });
      assert.equal(destination.state.executorAllowance, 90_000_000n); assert.equal(destination.state.venueAllowance, 0n);
      assert.equal(destination.state.totalCashSpent, 10_000_000n); assert.equal(destination.state.totalSharesPurchased, 20_000_000n);
      evidence.stages.feeFunding = { ...funding, fundedLamports: 2_000_000n, initializerBalanceComparison: "Excluded: large genesis balance is not narrowed or compared" };
      evidence.stages.beforeDelivery = { source: before, economics: economics(before), evm: destination };
    });
    await check("finalized accept_filled persists complete Settled record, one event and exact SPL effects", async () => {
      const delivery = await submit(instruction, operator);
      assert.deepEqual(delivery.requiredSigners, [operator.publicKey.toBase58()]);
      assert.notEqual(delivery.signature, creation.signature); assert.ok(delivery.finalizedSlot > creation.finalizedSlot);
      equalDecoded(delivery.events, [{ name: "filledAccepted", data: { order: keys.order, termsHash: [...independent.hash],
        receiptHash: [...independent.receipt], cashAmount: new BN("10000000"), filledQuantity: new BN("20000000") } }]);
      assert.deepEqual(delivery.inner, [
        { parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(), accounts: [keys.yesMint, keys.userYesAta, yesAuthority].map((k) => k.toBase58()),
          dataHex: Buffer.concat([Buffer.from([14]), uint(20_000_000n, 8, true), Buffer.from([6])]).toString("hex") },
        { parentIndex: 0, program: TOKEN_PROGRAM_ID.toBase58(), accounts: [keys.escrow, keys.cashMint, keys.executorCashAta, keys.order].map((k) => k.toBase58()),
          dataHex: Buffer.concat([Buffer.from([12]), uint(10_000_000n, 8, true), Buffer.from([6])]).toString("hex") } ]);
      after = await snapshot(); assert.ok(after.contextSlot >= delivery.finalizedSlot);
      assert.deepEqual(economics(after), { userCash: 15_000_000n, escrow: 0n, executorCash: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 20_000_000n, yesSupply: 20_000_000n, counters: [10_000_000n, 0n, 10_000_000n, 20_000_000n] });
      const oldOrder = program.coder.accounts.decode("order", Buffer.from(before.records.order.dataHex, "hex"));
      const newOrder = program.coder.accounts.decode("order", Buffer.from(after.records.order.dataHex, "hex"));
      equalDecoded(newOrder, { ...oldOrder, state: { settled: {} }, acceptedReceipt: { terminal: 1,
        filledQuantity: new BN("20000000"), receiptHash: [...independent.receipt] } });
      // Independent complete Borsh terminal record, including bumps and padding.
      const orderBefore = Buffer.from(before.records.order.dataHex, "hex");
      const terminalBytes = Buffer.concat([orderBefore.subarray(0, 289), Buffer.from([2, 0, 1, 1]), uint(20_000_000n, 8, true),
        independent.receipt, orderBefore.subarray(292, 294)]);
      assert.equal(terminalBytes.length, 335); assert.equal(after.records.order.dataHex, terminalBytes.toString("hex"));
      const accountingBytes = Buffer.concat([disc("account:Accounting"), keys.config.toBuffer(), ...[10_000_000n, 0n, 10_000_000n, 20_000_000n].map((n) => uint(n, 16, true)),
        Buffer.from([source.bumps.accounting])]);
      assert.equal(after.records.accounting.dataHex, accountingBytes.toString("hex"));
      const expected = structuredClone(before);
      for (const [name, offset, amount] of [["yesMint", 36, 20_000_000n], ["userYesAta", 64, 20_000_000n],
        ["escrow", 64, 0n], ["executorCashAta", 64, 10_000_000n]] as const) {
        const b = Buffer.from(expected.records[name].dataHex, "hex"); b.writeBigUInt64LE(amount, offset); expected.records[name].dataHex = b.toString("hex");
      }
      expected.records.order.dataHex = terminalBytes.toString("hex"); expected.records.accounting.dataHex = accountingBytes.toString("hex");
      assert.deepEqual(after.records, expected.records);
      assert.deepEqual(after.protocolAccounts, expected.protocolAccounts.map((record) => ({ ...record,
        dataHex: Object.values(expected.records).find((r) => r.address === record.address)!.dataHex })));
      assert.deepEqual(after.feePayer, { ...before.feePayer, lamports: before.feePayer.lamports - delivery.fee });
      assert.deepEqual((await evmSnapshot()).state, destination.state);
      evidence.stages.delivery = { ...delivery, source: after, economics: economics(after), evm: await evmSnapshot(), decodedOrder: newOrder };
    });
    await check("explicit identical instruction replay finalizes without CPI, event or economic change", async () => {
      // Do not invoke the Pending-only reader or rebuild terminal eligibility.
      const replay = await submit(instruction, operator);
      const delivered = evidence.stages.delivery as { signature: string };
      assert.notEqual(replay.signature, delivered.signature); assert.deepEqual(replay.requiredSigners, [operator.publicKey.toBase58()]);
      assert.deepEqual(replay.events, []); assert.deepEqual(replay.inner, []);
      assert.ok(!(replay.logs ?? []).some((line) => /invoke \[[2-9]/.test(line)));
      const final = await snapshot(); assert.ok(final.contextSlot >= replay.finalizedSlot);
      assert.deepEqual(final.records, after.records); assert.deepEqual(final.protocolAccounts, after.protocolAccounts);
      assert.deepEqual(economics(final), economics(after));
      assert.deepEqual(final.feePayer, { ...after.feePayer, lamports: after.feePayer.lamports - replay.fee });
      assert.deepEqual((await evmSnapshot()).state, destination.state);
      evidence.stages.replay = { ...replay, source: final, economics: economics(final), evm: await evmSnapshot(), additionalEconomicEffect: false };
    });
    await check("finalized SPL decoding conserves source cash and matches YES issuance to EVM custody", async () => {
      const final = await snapshot();
      const e = economics(final);
      assert.equal(e.cashSupply, e.userCash + e.escrow + e.executorCash);
      assert.equal(e.counters[0], e.escrow + e.counters[1] + e.counters[2]);
      assert.equal(e.counters[3], e.yesSupply); assert.equal(e.yesSupply, e.userYes);
      assert.equal(e.yesSupply, confirmed.receipt.filledQuantity); assert.equal(e.yesSupply, destination.state.totalSharesPurchased);
      const response = await connection.getMultipleAccountsInfoAndContext([keys.cashMint, keys.yesMint, keys.userYesAta, keys.executorCashAta, keys.escrow], {
        commitment: "finalized", minContextSlot: latestSlot });
      assert.ok(response.context.slot >= latestSlot);
      assert.equal(unpackMint(keys.cashMint, response.value[0]!, TOKEN_PROGRAM_ID).supply, 25_000_000n);
      assert.equal(unpackMint(keys.yesMint, response.value[1]!, TOKEN_PROGRAM_ID).supply, 20_000_000n);
      for (const [index, key, owner, amount] of [[2, keys.userYesAta, user, 20_000_000n],
        [3, keys.executorCashAta, new PublicKey(source.roles.executor), 10_000_000n], [4, keys.escrow, keys.order, 0n]] as const) {
        const token = unpackAccount(key, response.value[index]!, TOKEN_PROGRAM_ID); assert.ok(token.owner.equals(owner)); assert.equal(token.amount, amount);
      }
      assert.equal(constructionActivity, 0);
      evidence.stages.conservation = { contextSlot: response.context.slot, sourceCash: { supply: e.cashSupply, user: e.userCash, escrow: e.escrow, executor: e.executorCash },
        accounting: e.counters, sourceYesSupply: e.yesSupply, sourceUserYes: e.userYes, evmOrderCustodyBacking: confirmed.receipt.filledQuantity,
        separateFeePayerFinalLamports: final.feePayer.lamports, unchangedEvmState: true };
    });
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally { provider.destroy(); persist(); }
});
