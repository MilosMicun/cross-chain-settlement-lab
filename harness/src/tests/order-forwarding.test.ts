import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { EvmTerms, FinalizedPendingOrder } from "../source-order.ts";
const { forwardPendingOrder } = await import(new URL("../order-forwarding.ts", import.meta.url).href) as typeof import("../order-forwarding.ts");
const { readFinalizedPendingOrder } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-order-forwarding.sh with both owned live chains");
assert.equal(resolve(runtime, ".."), join(root, ".runtime"));
assert.ok(basename(runtime).startsWith("dual-chain-setup-"));
const json = (path: string) => JSON.parse(readFileSync(join(runtime, path), "utf8"));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const disc = (name: string) => sha(Buffer.from(`account:${name}`)).subarray(0, 8);
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const bytes = (value: string) => Buffer.from(value.slice(2), "hex");
const u64 = (value: bigint, little = false) => {
  const result = Buffer.alloc(8);
  if (little) result.writeBigUInt64LE(value); else result.writeBigUInt64BE(value);
  return result;
};
const compiled = (name: string): InterfaceAbi => JSON.parse(readFileSync(join(root, `evm/out/${name}.sol/${name}.json`), "utf8")).abi;
function credential(name: string) {
  const path = join(runtime, "credentials", `${name}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  return { address: key.toBase58(), account: info && { owner: info.owner.toBase58(), executable: info.executable,
    lamports: info.lamports, dataHex: info.data.toString("hex"), space: info.data.length } };
}

test("finalized source deposit forwards one EVM purchase while source awaits receipt delivery", { timeout: 550_000 }, async (t) => {
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  let forwarding = false;
  const moduleCalls: { chain: string; method: string; params?: unknown }[] = [];
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      if (forwarding) {
        const call = JSON.parse(String(init?.body));
        moduleCalls.push({ chain: "Solana", method: call.method, params: call.params });
        assert.equal(call.method, "getMultipleAccounts", "Forwarder may only read source accounts");
        assert.equal(call.params[1].commitment, "finalized");
      }
      return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  });
  const send = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    if (forwarding) {
      moduleCalls.push({ chain: "EVM", method });
      assert.ok(["eth_chainId", "eth_call", "eth_estimateGas", "eth_sendTransaction", "eth_getTransactionByHash",
        "eth_blockNumber", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getBlockByNumber"].includes(method), method);
    }
    return send(method, params);
  };
  const evm = json("evm-deployment-manifest.json") as EvmDeploymentManifest;
  const source = json("solana-deployment-manifest.json") as SolanaDeploymentManifest;
  const setup = json("agreement-evidence.json") as { checks: string[]; failure?: string; observed: { agreement: LiveConfigurationObservation } };
  assert.equal(setup.failure, undefined); assert.ok(setup.checks.length > 0);
  const agreement = setup.observed.agreement;
  const initializer = credential("initializer");
  const programId = new PublicKey(source.programId);
  const config = new PublicKey(source.accounts.config), accounting = new PublicKey(source.accounts.accounting);
  const cashMint = new PublicKey(source.mints.cash), yesMint = new PublicKey(source.mints.yes);
  const executorCash = new PublicKey(source.accounts.executorCashAta);
  const program = new Program<SettlementLab>(JSON.parse(readFileSync(join(root, "solana/target/idl/settlement_lab.json"), "utf8")),
    new AnchorProvider(connection, new Wallet(initializer), { commitment: "finalized" }));
  assert.ok(program.programId.equals(programId));
  const parser = new EventParser(programId, program.coder);
  const settlement = new Contract(evm.contracts.settlement, compiled("Settlement"), provider);
  const usd = new Contract(evm.contracts.usd, compiled("MockERC20"), provider);
  const yes = new Contract(evm.contracts.yes, compiled("MockERC20"), provider);
  const evidence: { scope: string; checks: string[]; stages: Record<string, unknown>; limitations: string[]; failure?: string } = {
    scope: "Real finalized Solana creation and EVM purchase with explicit duplicate delivery; source deliberately awaits receipt delivery. Not completed cross-chain settlement.",
    checks: [], stages: { setupAgreement: agreement }, limitations: [
      "Explicit trusted operator; no cryptographic cross-chain proof or production finality guarantee.",
      "Finalized Pending is not a lock; cancellation can race. Settlement enforces destination terminal exclusivity.",
      "Status-1 receipts, canonical terminal storage and two test-mined blocks are a test-level confirmation check, not the reusable terminal-finality observer.",
      "No receipt delivery, source YES issuance/reimbursement, cancellation forwarding, refund, automatic retry or unknown-outcome/restart recovery.",
      "Forwarding errors/timeouts can leave broadcast outcome unknown; they do not establish Unseen or authorize refunds or resend.",
      "Local setup retains the existing Agave 4.1.2 SIMD-0500 genesis limitation recorded in setup evidence.",
    ],
  };
  const persist = () => writeFileSync(join(runtime, "order-forwarding-evidence.json"),
    JSON.stringify(evidence, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  async function check(name: string, action: () => Promise<void>) {
    let failure: unknown;
    await t.test(name, async () => {
      try { await action(); evidence.checks.push(name); persist(); }
      catch (error) { failure = error; throw error; }
    });
    if (failure) throw failure;
  }
  let latestSlot = agreement.solana.contextSlot;
  const user = Keypair.generate();
  const userCash = getAssociatedTokenAddressSync(cashMint, user.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userYes = getAssociatedTokenAddressSync(yesMint, user.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const nonce = 0n, cashAmount = 10_000_000n, minimumShares = 20_000_000n;
  const [userNonce, userBump] = PublicKey.findProgramAddressSync([Buffer.from("user"), config.toBuffer(), user.publicKey.toBuffer()], programId);
  const [order, orderBump] = PublicKey.findProgramAddressSync([Buffer.from("order"), config.toBuffer(), user.publicKey.toBuffer(), u64(nonce)], programId);
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), order.toBuffer()], programId);
  const keys = [config, accounting, userNonce, order, cashMint, yesMint, executorCash, userCash, userYes, escrow, user.publicKey];
  // Independent SPEC preimages from selected deployment inputs, not reader/stored hashes.
  const domain = Buffer.concat([bytes(evm.sourceDomain), bytes(evm.destinationDomain), programId.toBuffer(),
    Buffer.from(BigInt(evm.chainId).toString(16).padStart(64, "0"), "hex"), bytes(evm.contracts.settlement)]);
  assert.equal(domain.length, 148);
  const identityPreimage = Buffer.concat([Buffer.from("CCSLID01"), domain, user.publicKey.toBuffer(), u64(nonce)]);
  assert.equal(identityPreimage.length, 196);
  const expectedId = sha(identityPreimage);
  const termsPreimage = Buffer.concat([Buffer.from("CCSLTR01"), domain, expectedId, user.publicKey.toBuffer(),
    u64(nonce), bytes(evm.market), Buffer.from([0]), u64(cashAmount), u64(minimumShares)]);
  assert.equal(termsPreimage.length, 277);
  const expectedTermsHash = sha(termsPreimage);
  const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), expectedTermsHash, Buffer.from([1]), u64(20_000_000n)]);
  assert.equal(receiptPreimage.length, 49);
  const expectedReceiptHash = hex(sha(receiptPreimage));
  const expectedTerms = { identity: { domain: { sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
    solanaProgram: hex(programId.toBytes()), chainId: 31337n, settlement: evm.contracts.settlement.toLowerCase() },
    user: hex(user.publicKey.toBytes()), nonce }, market: evm.market, outcome: 0, cashAmount, minimumShares };
  evidence.stages.selectedInputs = { user: user.publicKey.toBase58(), nonce, cashAmount, minimumShares,
    fixtureCash: 25_000_000n, accounts: Object.fromEntries(["config", "accounting", "userNonce", "order", "cashMint", "yesMint",
      "executorCashAta", "userCashAta", "userYesAta", "escrow", "user"].map((name, i) => [name, keys[i].toBase58()])),
    independentHashes: { orderId: hex(expectedId), termsHash: hex(expectedTermsHash), receiptHash: expectedReceiptHash,
      identityPreimage: hex(identityPreimage), termsPreimage: hex(termsPreimage), receiptPreimage: hex(receiptPreimage) } };

  async function sourceSnapshot() {
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot: latestSlot });
    assert.ok(response.context.slot >= latestSlot);
    const protocol = await connection.getProgramAccounts(programId, { commitment: "finalized", minContextSlot: response.context.slot, withContext: true });
    assert.ok(protocol.context.slot >= response.context.slot);
    const signatures = (await connection.getSignaturesForAddress(programId, { limit: 100 }, "finalized")).map((item) => ({
      signature: item.signature, slot: item.slot, err: item.err, confirmationStatus: item.confirmationStatus,
    }));
    return { contextSlot: response.context.slot, protocolContextSlot: protocol.context.slot,
      state: { accounts: response.value.map((info, i) => publicAccount(keys[i], info)),
        protocolAccounts: protocol.value.map((item) => publicAccount(item.pubkey, item.account)).sort((a, b) => a.address.localeCompare(b.address)), signatures } };
  }
  function sourceEconomics(snapshot: Awaited<ReturnType<typeof sourceSnapshot>>) {
    const raw = snapshot.state.accounts;
    const data = (index: number) => { assert.ok(raw[index].account); return Buffer.from(raw[index].account.dataHex, "hex"); };
    const amount = (index: number) => data(index).readBigUInt64LE(64);
    const supply = (index: number) => data(index).readBigUInt64LE(36);
    const counters = Array.from({ length: 4 }, (_, i) => data(1).readBigUInt64LE(40 + i * 16)
      + (data(1).readBigUInt64LE(48 + i * 16) << 64n));
    return { userCash: amount(7), escrow: raw[9].account ? amount(9) : 0n, cashSupply: supply(4), userYes: amount(8), yesSupply: supply(5),
      executorCash: amount(6), counters };
  }
  async function submit(instructions: TransactionInstruction[], payer: Keypair) {
    const block = await connection.getLatestBlockhash("finalized");
    const transaction = new Transaction({ ...block, feePayer: payer.publicKey }).add(...instructions); transaction.sign(payer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "finalized", maxRetries: 0 });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === "finalized") {
        const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        assert.ok(receipt?.meta); assert.equal(status.err, null); assert.equal(receipt.meta.err, null); assert.equal(receipt.slot, status.slot);
        latestSlot = Math.max(latestSlot, receipt.slot);
        const events = [...parser.parseLogs(receipt.meta.logMessages ?? [])];
        const requiredSigners = receipt.transaction.message.staticAccountKeys.slice(0, receipt.transaction.message.header.numRequiredSignatures).map((key) => key.toBase58());
        assert.ok(requiredSigners.includes(payer.publicKey.toBase58()));
        return { signature, finalizedSlot: receipt.slot, requiredSigners, events: events.map((event) => event.name),
          instructions: receipt.transaction.message.compiledInstructions, logs: receipt.meta.logMessages };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Source transaction finalization deadline exceeded: ${signature}`);
  }
  async function economicState() {
    const blockNumber = Number(BigInt(await provider.send("eth_blockNumber", [])));
    const read = (contract: Contract, name: string, ...args: unknown[]) => contract.getFunction(name).staticCall(...args, { blockTag: blockNumber });
    const balances: Record<string, { supply: bigint; holders: Record<string, bigint> }> = {};
    for (const [name, token] of [["usd", usd], ["yes", yes]] as const) {
      const holders: Record<string, bigint> = {};
      for (const [role, address] of Object.entries({ ...evm.roles, venue: evm.contracts.venue, settlement: evm.contracts.settlement })) {
        holders[role] = await read(token, "balanceOf", address);
      }
      const supply: bigint = await read(token, "totalSupply");
      assert.equal(Object.values(holders).reduce((sum, balance) => sum + balance, 0n), supply, `${name} known balances conserve supply`);
      balances[name] = { supply, holders };
    }
    const record = await read(settlement, "orderRecord", hex(expectedId));
    const d = record.terms.identity.domain;
    const storedTerms = { identity: { domain: { sourceDomain: d.sourceDomain, destinationDomain: d.destinationDomain,
      solanaProgram: d.solanaProgram, chainId: d.chainId, settlement: d.settlement.toLowerCase() },
      user: record.terms.identity.user, nonce: record.terms.identity.nonce }, market: record.terms.market,
      outcome: Number(record.terms.outcome), cashAmount: record.terms.cashAmount, minimumShares: record.terms.minimumShares };
    return { blockNumber, blockHash: (await provider.getBlock(blockNumber))!.hash, state: { balances,
      executorAllowance: await read(usd, "allowance", evm.roles.executor, evm.contracts.settlement),
      venueAllowance: await read(usd, "allowance", evm.contracts.settlement, evm.contracts.venue),
      totalCashSpent: await read(settlement, "totalCashSpent"), totalSharesPurchased: await read(settlement, "totalSharesPurchased"),
      record: { terms: storedTerms, termsHash: record.termsHash, status: record.status, filledQuantity: record.filledQuantity, receiptHash: record.receiptHash } } };
  }
  function filledEconomics(state: Awaited<ReturnType<typeof economicState>>["state"]) {
    assert.deepEqual(state, { balances: {
      usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 90_000_000n, venue: 10_000_000n, settlement: 0n } },
      yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 180_000_000n, settlement: 20_000_000n } },
    }, executorAllowance: 90_000_000n, venueAllowance: 0n, totalCashSpent: 10_000_000n, totalSharesPurchased: 20_000_000n,
    record: { terms: expectedTerms, termsHash: hex(expectedTermsHash), status: 1n, filledQuantity: 20_000_000n, receiptHash: expectedReceiptHash } });
  }
  async function confirmed(hash: string, terms: EvmTerms) {
    const receipt = await provider.waitForTransaction(hash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, 1);
    const transaction = await provider.getTransaction(hash); assert.ok(transaction);
    assert.equal(transaction.from.toLowerCase(), evm.roles.operator.toLowerCase());
    assert.equal(transaction.to?.toLowerCase(), evm.contracts.settlement.toLowerCase()); assert.equal(transaction.chainId, 31337n);
    assert.equal(transaction.data, settlement.interface.encodeFunctionData("execute", [hex(expectedId), terms])); assert.equal(transaction.value, 0n);
    await provider.send("evm_mine", []); await provider.send("evm_mine", []);
    const head = Number(BigInt(await provider.send("eth_blockNumber", [])));
    assert.ok(head >= receipt.blockNumber + 2);
    const canonical = await provider.getBlock(receipt.blockNumber); assert.equal(canonical?.hash, receipt.blockHash);
    const reread = await provider.getTransactionReceipt(hash); assert.ok(reread); assert.equal(reread.status, 1); assert.equal(reread.blockHash, receipt.blockHash);
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    return { receipt, gasCost, public: { submissionHash: hash, receipt: receipt.toJSON(), transaction: transaction.toJSON(),
      canonicalBlock: { number: canonical!.number, hash: canonical!.hash }, observedHead: head, additionalBlocks: head - receipt.blockNumber, gasCost } };
  }
  let sourceBefore: Awaited<ReturnType<typeof sourceSnapshot>>;
  let afterPurchase: Awaited<ReturnType<typeof economicState>>;
  let validated: FinalizedPendingOrder;
  let creationSlot = 0;
  try {
    const operator = await provider.getSigner(evm.roles.operator);
    const wrongOperator = await provider.getSigner(evm.roles.executor);
    const input = () => ({ provider, operator, connection, expectedConfiguration: agreement, user: user.publicKey, nonce, minFinalizedSlot: creationSlot });
    async function forward(signer = operator) {
      forwarding = true;
      try { return await forwardPendingOrder({ ...input(), operator: signer }); }
      finally { forwarding = false; }
    }
    await check("reuse successful setup agreement and unchanged live deployments", async () => {
      assert.deepEqual(await verifyLiveConfiguration({ provider, connection, evmManifest: evm, solanaManifest: source,
        minFinalizedSlot: latestSlot }).then((value) => value.evm.configuration), agreement.evm.configuration);
      assert.equal((await economicState()).blockNumber, 9);
      const before = await sourceSnapshot();
      assert.equal(before.state.accounts[2].account, null); assert.equal(before.state.accounts[3].account, null); assert.equal(before.state.accounts[9].account, null);
      assert.equal(before.state.protocolAccounts.length, 2); evidence.stages.beforeFixture = before;
    });
    await check("new original user credential stays private and real SPL fixture finalizes", async () => {
      assert.ok(![source.roles.operator, source.roles.executor, source.roles.initializer].includes(user.publicKey.toBase58()));
      const path = join(runtime, "credentials", "forwarding-user.json");
      writeFileSync(path, JSON.stringify(Array.from(user.secretKey)) + "\n", { mode: 0o600, flag: "wx" });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const fixture = await submit([
        SystemProgram.transfer({ fromPubkey: initializer.publicKey, toPubkey: user.publicKey, lamports: 1_000_000_000 }),
        createAssociatedTokenAccountInstruction(initializer.publicKey, userCash, user.publicKey, cashMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(initializer.publicKey, userYes, user.publicKey, yesMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createMintToInstruction(cashMint, userCash, initializer.publicKey, 25_000_000n, [], TOKEN_PROGRAM_ID),
      ], initializer);
      const snapshot = await sourceSnapshot();
      assert.deepEqual(sourceEconomics(snapshot), { userCash: 25_000_000n, escrow: 0n, cashSupply: 25_000_000n, userYes: 0n,
        yesSupply: 0n, executorCash: 0n, counters: [0n, 0n, 0n, 0n] });
      assert.equal(snapshot.state.accounts[10].account!.lamports, 1_000_000_000);
      for (const [key, mint] of [[userCash, cashMint], [userYes, yesMint]] as const) {
        const info = await connection.getAccountInfo(key, { commitment: "finalized", minContextSlot: latestSlot }); assert.ok(info);
        assert.ok(info.owner.equals(TOKEN_PROGRAM_ID)); const token = unpackAccount(key, info, TOKEN_PROGRAM_ID);
        assert.ok(token.owner.equals(user.publicKey) && token.mint.equals(mint)); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
      }
      evidence.stages.fixture = { ...fixture, snapshot, economics: sourceEconomics(snapshot) };
    });
    await check("actual create_order requires original-user signature and finalizes a canonical Pending deposit", async () => {
      const instruction = await program.methods.createOrder({ nonce: new BN(nonce.toString()), cashAmount: new BN(cashAmount.toString()),
        minimumShares: new BN(minimumShares.toString()) }).accountsStrict({ user: user.publicKey, config, accounting, userNonce, order, cashMint,
        yesMint, userCashAta: userCash, userYesAta: userYes, escrow, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
      assert.equal(instruction.keys.find((meta) => meta.pubkey.equals(user.publicKey))?.isSigner, true);
      const creation = await submit([instruction], user); creationSlot = creation.finalizedSlot;
      assert.deepEqual(creation.requiredSigners, [user.publicKey.toBase58()]); assert.deepEqual(creation.events, ["orderCreated"]);
      sourceBefore = await sourceSnapshot();
      const orderInfo = sourceBefore.state.accounts[3].account!;
      assert.equal(orderInfo.owner, programId.toBase58()); assert.equal(orderInfo.executable, false); assert.equal(orderInfo.space, 335);
      const expectedOrder = Buffer.concat([disc("Order"), config.toBuffer(), user.publicKey.toBuffer(), u64(nonce, true), bytes(evm.market),
        Buffer.from([0]), u64(cashAmount, true), u64(minimumShares, true), expectedId, expectedTermsHash, userCash.toBuffer(), userYes.toBuffer(),
        escrow.toBuffer(), Buffer.from([0, 0, 0, orderBump, escrowBump]), Buffer.alloc(41)]);
      assert.equal(orderInfo.dataHex, expectedOrder.toString("hex"));
      assert.equal(sourceBefore.state.accounts[2].account!.owner, programId.toBase58());
      assert.equal(sourceBefore.state.accounts[2].account!.dataHex, Buffer.concat([disc("UserNonce"), config.toBuffer(), user.publicKey.toBuffer(),
        u64(1n, true), Buffer.from([userBump])]).toString("hex"));
      const accountingBytes = Buffer.from(agreement.solana.config.dataHex, "hex");
      assert.equal(sourceBefore.state.accounts[0].account!.dataHex, accountingBytes.toString("hex"));
      const ledger = Buffer.concat([disc("Accounting"), config.toBuffer(), u64(cashAmount, true), Buffer.alloc(56), Buffer.from([source.bumps.accounting])]);
      assert.equal(sourceBefore.state.accounts[1].account!.dataHex, ledger.toString("hex"));
      const decoded = program.coder.accounts.decode("order", expectedOrder);
      assert.deepEqual(decoded.state, { pending: {} }); assert.equal(decoded.cancellationRequested, false); assert.equal(decoded.acceptedReceipt, null);
      const info = await connection.getAccountInfo(escrow, { commitment: "finalized", minContextSlot: creationSlot }); assert.ok(info);
      const token = unpackAccount(escrow, info, TOKEN_PROGRAM_ID);
      assert.ok(token.owner.equals(order) && token.mint.equals(cashMint)); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
      assert.equal(token.isInitialized, true); assert.equal(token.isFrozen, false); assert.equal(token.isNative, false);
      assert.deepEqual(sourceEconomics(sourceBefore), { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      assert.equal(sourceBefore.state.protocolAccounts.length, 4);
      evidence.stages.creation = { ...creation, snapshot: sourceBefore, economics: sourceEconomics(sourceBefore), nextNonce: 1n,
        cancellationRequested: false, acceptedReceipt: null, state: "Pending" };
    });
    await check("readFinalizedPendingOrder uses creation slot and matches independent identities and hashes", async () => {
      validated = await readFinalizedPendingOrder(input());
      assert.ok(validated.contextSlot >= creationSlot); assert.equal(validated.orderId, hex(expectedId)); assert.equal(validated.termsHash, hex(expectedTermsHash));
      assert.deepEqual(validated.terms, expectedTerms); assert.equal(validated.escrowBalance, cashAmount);
      assert.deepEqual(validated.accounts, { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(), escrow: escrow.toBase58(),
        userCashAta: userCash.toBase58(), userYesAta: userYes.toBase58() }); evidence.stages.reader = validated;
    });
    await check("first submission starts from empty destination with conserved fixture supplies", async () => {
      const before = await economicState(); assert.equal(before.state.record.status, 0n);
      assert.deepEqual(before.state.balances, { usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 100_000_000n, venue: 0n, settlement: 0n } },
        yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 200_000_000n, settlement: 0n } } });
      assert.equal(before.state.executorAllowance, 100_000_000n); assert.equal(before.state.venueAllowance, 0n);
      assert.equal(before.state.totalCashSpent, 0n); assert.equal(before.state.totalSharesPurchased, 0n);
      evidence.stages.beforeExecution = before;
      const fresh = await sourceSnapshot(); assert.deepEqual(fresh.state, sourceBefore.state); evidence.stages.sourceBeforeExecution = fresh;
    });
    await check("configured operator submits actual execute calldata and receives one canonical Filled event", async () => {
      const nativeBefore = await provider.getBalance(evm.roles.operator);
      const start = moduleCalls.length;
      const submission = await forward();
      assert.deepEqual(submission.sourceOrder.terms, expectedTerms); assert.equal(submission.sourceOrder.orderId, hex(expectedId));
      assert.equal(submission.sourceOrder.termsHash, hex(expectedTermsHash)); assert.ok(submission.sourceOrder.contextSlot >= creationSlot);
      const confirmation = await confirmed(submission.transactionHash, submission.sourceOrder.terms);
      assert.equal(await provider.getBalance(evm.roles.operator), nativeBefore - confirmation.gasCost);
      const events = confirmation.receipt.logs.filter((log) => log.address.toLowerCase() === evm.contracts.settlement.toLowerCase())
        .map((log) => settlement.interface.parseLog(log));
      assert.equal(events.length, 1); assert.equal(events[0]?.name, "TerminalRecorded");
      assert.deepEqual(Array.from(events[0]!.args), [hex(expectedId), hex(expectedTermsHash), 1n, 20_000_000n, expectedReceiptHash]);
      const calls = moduleCalls.slice(start);
      assert.equal(calls.filter((call) => call.method === "eth_sendTransaction").length, 1);
      assert.equal(calls.filter((call) => call.chain === "Solana").length, 1);
      afterPurchase = await economicState(); filledEconomics(afterPurchase.state);
      assert.equal((await settlement.queryFilter(settlement.filters.TerminalRecorded(hex(expectedId)), 0, afterPurchase.blockNumber)).length, 1);
      evidence.stages.purchase = { submission, ...confirmation.public, event: { orderId: hex(expectedId), termsHash: hex(expectedTermsHash), terminal: 1,
        filledQuantity: 20_000_000n, receiptHash: expectedReceiptHash }, economics: afterPurchase, moduleCalls: calls, operatorNativeBefore: nativeBefore,
        operatorNativeAfter: await provider.getBalance(evm.roles.operator) };
    });
    await check("delayed receipt leaves exact source accounts, activity, escrow, supplies and counters unchanged", async () => {
      const after = await sourceSnapshot(); assert.deepEqual(after.state, sourceBefore.state);
      assert.deepEqual(sourceEconomics(after), sourceEconomics(sourceBefore));
      evidence.stages.sourceAfterPurchase = { snapshot: after, economics: sourceEconomics(after), exactStateUnchanged: true,
        noSourceTransactionsOrSettlementEvents: true, receiptDelivered: false };
    });
    await check("explicit duplicate succeeds with identical terminal record and no events or economic effects", async () => {
      const nativeBefore = await provider.getBalance(evm.roles.operator);
      const start = moduleCalls.length;
      const duplicate = await forward(); assert.notEqual(duplicate.transactionHash, (evidence.stages.purchase as { submission: { transactionHash: string } }).submission.transactionHash);
      assert.deepEqual(duplicate.sourceOrder.terms, validated.terms); assert.equal(duplicate.sourceOrder.orderId, validated.orderId);
      const confirmation = await confirmed(duplicate.transactionHash, duplicate.sourceOrder.terms);
      assert.equal(confirmation.receipt.logs.length, 0, "No TerminalRecorded, Transfer, Approval or venue events on exact replay");
      assert.equal(await provider.getBalance(evm.roles.operator), nativeBefore - confirmation.gasCost);
      const after = await economicState(); filledEconomics(after.state); assert.deepEqual(after.state, afterPurchase.state);
      assert.equal((await settlement.queryFilter(settlement.filters.TerminalRecorded(hex(expectedId)), 0, after.blockNumber)).length, 1);
      const sourceAfter = await sourceSnapshot(); assert.deepEqual(sourceAfter.state, sourceBefore.state);
      const calls = moduleCalls.slice(start); assert.equal(calls.filter((call) => call.method === "eth_sendTransaction").length, 1);
      evidence.stages.duplicate = { submission: duplicate, ...confirmation.public, economics: after, sourceSnapshot: sourceAfter,
        sourceEconomics: sourceEconomics(sourceAfter), newEvents: 0, additionalTokenSpending: 0n, moduleCalls: calls,
        operatorNativeBefore: nativeBefore, operatorNativeAfter: await provider.getBalance(evm.roles.operator) };
    });
    await check("wrong EVM role is rejected by module before any submission with exact unchanged state", async () => {
      const before = await economicState();
      const nonces = async () => Promise.all([evm.roles.operator, evm.roles.executor].map((address) => provider.send("eth_getTransactionCount", [address, "pending"])));
      const nonceBefore = await nonces();
      const nativeBefore = await Promise.all([evm.roles.operator, evm.roles.executor].map((address) => provider.getBalance(address)));
      const start = moduleCalls.length;
      await assert.rejects(forward(wrongOperator), /Operator signer differs from the configured EVM operator/);
      const calls = moduleCalls.slice(start); assert.equal(calls.length, 0, "Wrong role rejects before any source RPC or EVM submission");
      assert.deepEqual(await nonces(), nonceBefore);
      assert.deepEqual(await Promise.all([evm.roles.operator, evm.roles.executor].map((address) => provider.getBalance(address))), nativeBefore);
      const after = await economicState(); assert.deepEqual(after, before);
      const sourceAfter = await sourceSnapshot(); assert.deepEqual(sourceAfter.state, sourceBefore.state);
      evidence.stages.wrongOperator = { address: evm.roles.executor, rejected: true, reason: "Operator signer differs from the configured EVM operator",
        transactionsSubmitted: 0, calls, nonceBefore, nonceAfter: await nonces(), economicsBefore: before, economicsAfter: after, sourceSnapshot: sourceAfter };
    });
    await check("final conservation and source receipt boundary hold without issuance or reimbursement", async () => {
      const snapshot = await sourceSnapshot(); assert.deepEqual(snapshot.state, sourceBefore.state);
      const economic = sourceEconomics(snapshot);
      assert.equal(economic.cashSupply, economic.userCash + economic.escrow + economic.executorCash);
      assert.equal(economic.counters[0], economic.escrow + economic.counters[1] + economic.counters[2]);
      assert.equal(economic.yesSupply, 0n); assert.equal(economic.counters[3], 0n); assert.equal(economic.executorCash, 0n);
      const finalEvm = await economicState(); filledEconomics(finalEvm.state);
      const recheck = await readFinalizedPendingOrder(input()); assert.equal(recheck.state, "Pending"); assert.equal(recheck.escrowBalance, 10_000_000n);
      evidence.stages.finalBoundary = { sourceSnapshot: snapshot, sourceEconomics: economic, reader: recheck, evm: finalEvm,
        receiptsDelivered: 0, sourceSettlementInstructions: 0, sourceSettlementEvents: 0, sourceState: "Pending", sourceYesIssued: 0n,
        sourceExecutorReimbursed: 0n, lockedDeposit: 10_000_000n, completedCrossChainSettlement: false };
      // Decode actual final mints independently as a final boundary assertion.
      for (const [mintKey, supply] of [[cashMint, 25_000_000n], [yesMint, 0n]] as const) {
        const info = await connection.getAccountInfo(mintKey, { commitment: "finalized", minContextSlot: creationSlot }); assert.ok(info);
        assert.equal(unpackMint(mintKey, info, TOKEN_PROGRAM_ID).supply, supply);
      }
    });
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally { provider.destroy(); persist(); }
});
