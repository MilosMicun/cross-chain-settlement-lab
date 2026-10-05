import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import anchor from "@anchor-lang/core";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction,
  type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { Contract, FetchRequest, JsonRpcProvider, toQuantity, type InterfaceAbi } from "ethers";
import type { SettlementLab } from "../../../solana/target/types/settlement_lab.ts";
import type { EvmDeploymentManifest } from "../evm-deployment.ts";
import type { SolanaDeploymentManifest } from "../solana-deployment.ts";
import type { LiveConfigurationObservation } from "../live-configuration.ts";
import type { Bytes32Hex, EvmTerms, FinalizedCancellationRequest } from "../source-order.ts";
import type { TerminalObservationRpc, TerminalReadMethod } from "../terminal-observation.ts";
const { forwardCancellationRequest } = await import(new URL("../cancellation-forwarding.ts", import.meta.url).href) as typeof import("../cancellation-forwarding.ts");
const { readFinalizedPendingOrder, readFinalizedCancellationRequest } = await import(new URL("../source-order.ts", import.meta.url).href) as typeof import("../source-order.ts");
const { verifyLiveConfiguration } = await import(new URL("../live-configuration.ts", import.meta.url).href) as typeof import("../live-configuration.ts");
const { observeTerminalOutcome } = await import(new URL("../terminal-observation.ts", import.meta.url).href) as typeof import("../terminal-observation.ts");
const { AnchorProvider, BN, EventParser, Program, Wallet } = anchor;
const root = resolve(import.meta.dirname, "../../..");
const runtime = process.env.DUAL_CHAIN_SETUP_RUNTIME ?? "";
assert.ok(runtime, "Use scripts/check-cancellation-forwarding.sh with both owned live chains");
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
// Only exactly representable balances are converted; the large genesis payer is
// excluded from native balance comparisons, never narrowed to an imprecise Number.
function safeLamports(value: number) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, "Lamports must be exactly representable");
  return BigInt(value);
}
function publicValue(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(publicValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicValue(v)]));
  return value;
}
function publicAccount(key: PublicKey, info: AccountInfo<Buffer> | null) {
  return { address: key.toBase58(), account: info && { owner: info.owner.toBase58(), executable: info.executable,
    lamports: safeLamports(info.lamports), dataHex: info.data.toString("hex"), space: info.data.length } };
}

test("user-signed live cancellation confirms destination Cancelled while source escrow stays locked", { timeout: 550_000 }, async (t) => {
  const request = new FetchRequest("http://127.0.0.1:18545"); request.timeout = 15_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 100;
  let forwarding = false, observing = false;
  const observerMethods = ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_call"];
  const observerProviderCalls: string[] = [];
  const moduleCalls: { chain: string; method: string; params?: unknown }[] = [];
  const connection = new Connection("http://127.0.0.1:18899", {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      assert.equal(observing, false, "Observer must never access source RPC");
      if (forwarding) {
        const call = JSON.parse(String(init?.body));
        moduleCalls.push({ chain: "Solana", method: call.method, params: call.params });
        assert.equal(call.method, "getMultipleAccounts", "Forwarder may only read source accounts");
        assert.equal(call.params[1].commitment, "finalized");
        assert.equal(call.params[1].minContextSlot, cancellationSlot);
      }
      return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    },
  });
  const send = provider.send.bind(provider);
  provider.send = async (method: string, params: unknown[] | Record<string, unknown>) => {
    if (observing) { observerProviderCalls.push(method); assert.ok(observerMethods.includes(method), `Forbidden observer RPC: ${method}`); }
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
    scope: "Finalized source user cancellation and confirmed destination Cancelled; source escrow stays locked. No completed cross-chain cancellation settlement.",
    checks: [], stages: { setupAgreement: agreement }, limitations: [
      "Explicit trusted operator/RPC model; no cryptographic cross-chain proof or production bridge/finality.",
      "Local N+2 confirmation requires a successful receipt and canonical matching terminal storage; only this test mines blocks.",
      "Confirmed destination Cancelled alone never refunds source escrow. No receipt delivery or refund in this task.",
      "Two forwarding calls are explicit test submissions, not automatic retry or restart recovery. No restart recovery is implemented.",
      "Existing Agave 4.1.2 SIMD-0500 genesis exception remains as recorded by setup evidence.",
    ],
  };
  const persist = () => writeFileSync(join(runtime, "cancellation-forwarding-live-evidence.json"),
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
  const receiptPreimage = Buffer.concat([Buffer.from("CCSLRC01"), expectedTermsHash, Buffer.from([2]), u64(0n)]);
  assert.equal(receiptPreimage.length, 49);
  const expectedReceiptHash = hex(sha(receiptPreimage));
  const expectedTerms = { identity: { domain: { sourceDomain: evm.sourceDomain, destinationDomain: evm.destinationDomain,
    solanaProgram: hex(programId.toBytes()), chainId: BigInt(evm.chainId), settlement: evm.contracts.settlement.toLowerCase() },
    user: hex(user.publicKey.toBytes()), nonce }, market: evm.market, outcome: 0, cashAmount, minimumShares };
  evidence.stages.selectedInputs = { user: user.publicKey.toBase58(), nonce, cashAmount, minimumShares,
    fixtureCash: 25_000_000n, deployment: { evm, source }, domainPreimage: hex(domain), accounts: Object.fromEntries(["config", "accounting", "userNonce", "order", "cashMint", "yesMint",
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
    const tokens = [];
    for (const [mintKey, index] of [[cashMint, 4], [yesMint, 5]] as const) {
      const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        commitment: "finalized", minContextSlot: response.context.slot,
        filters: [{ dataSize: ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mintKey.toBase58() } }],
      });
      const mintInfo = response.value[index]; assert.ok(mintInfo);
      const supply = unpackMint(mintKey, mintInfo, TOKEN_PROGRAM_ID).supply;
      const balances = accounts.map(({ pubkey, account }) => ({ address: pubkey.toBase58(), amount: unpackAccount(pubkey, account, TOKEN_PROGRAM_ID).amount }))
        .sort((a, b) => a.address.localeCompare(b.address));
      assert.equal(balances.reduce((sum, item) => sum + item.amount, 0n), supply);
      tokens.push({ mint: mintKey.toBase58(), supply, balances,
        accounts: accounts.map(({ pubkey, account }) => publicAccount(pubkey, account)).sort((a, b) => a.address.localeCompare(b.address)) });
    }
    return { contextSlot: response.context.slot, protocolContextSlot: protocol.context.slot,
      state: { accounts: response.value.map((info, i) => publicAccount(keys[i], info)), tokens,
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
        const message = receipt.transaction.message;
        const fee = safeLamports(receipt.meta.fee);
        return { signature, finalizedSlot: receipt.slot, requiredSigners, fee,
          events: events.map((event) => event.name), eventData: publicValue(events),
          instructions: message.compiledInstructions.map((ix) => ({ program: message.staticAccountKeys[ix.programIdIndex].toBase58(),
            accounts: ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()), dataHex: Buffer.from(ix.data).toString("hex") })),
          innerInstructions: receipt.meta.innerInstructions ?? [], logs: receipt.meta.logMessages,
          status: { confirmationStatus: status.confirmationStatus, err: status.err, slot: status.slot },
          metaError: receipt.meta.err,
          payerBalances: payer === initializer ? { comparison: "Excluded: large genesis balance is not narrowed or compared" }
            : { before: safeLamports(receipt.meta.preBalances[0]), after: safeLamports(receipt.meta.postBalances[0]) } };
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
  function cancelledEconomics(state: Awaited<ReturnType<typeof economicState>>["state"]) {
    assert.deepEqual(state, { balances: {
      usd: { supply: 100_000_000n, holders: { deployer: 0n, operator: 0n, executor: 100_000_000n, venue: 0n, settlement: 0n } },
      yes: { supply: 200_000_000n, holders: { deployer: 0n, operator: 0n, executor: 0n, venue: 200_000_000n, settlement: 0n } },
    }, executorAllowance: 100_000_000n, venueAllowance: 0n, totalCashSpent: 0n, totalSharesPurchased: 0n,
    record: { terms: expectedTerms, termsHash: hex(expectedTermsHash), status: 2n, filledQuantity: 0n, receiptHash: expectedReceiptHash } });
  }
  async function block(tag = "latest") {
    const value = await provider.send("eth_getBlockByNumber", [tag, false]); assert.ok(value);
    return { number: BigInt(value.number), hash: value.hash as Bytes32Hex };
  }
  let creationSlot = 0, cancellationSlot = 0;
  let pending: Awaited<ReturnType<typeof sourceSnapshot>>;
  let locked: Awaited<ReturnType<typeof sourceSnapshot>>;
  let firstTransaction: Awaited<ReturnType<typeof verifyTransaction>>;
  let permanentCancelled: string;
  const operator = await provider.getSigner(evm.roles.operator);
  const wrongOperator = await provider.getSigner(evm.roles.executor);
  const input = () => ({ provider, operator, connection, expectedConfiguration: agreement,
    user: user.publicKey, nonce, minFinalizedSlot: cancellationSlot });
  async function forward(signer = operator) {
    forwarding = true;
    try { return await forwardCancellationRequest({ ...input(), operator: signer }); }
    finally { forwarding = false; }
  }
  function verifySourceRequest(actual: FinalizedCancellationRequest) {
    assert.equal(actual.state, "CancelRequested"); assert.equal(actual.cancellationRequested, true);
    assert.ok(actual.contextSlot >= cancellationSlot); assert.equal(actual.orderId, hex(expectedId));
    assert.equal(actual.termsHash, hex(expectedTermsHash)); assert.deepEqual(actual.terms, expectedTerms);
    assert.equal(actual.escrowBalance, cashAmount);
    assert.deepEqual(actual.accounts, { config: config.toBase58(), userNonce: userNonce.toBase58(), order: order.toBase58(),
      escrow: escrow.toBase58(), userCashAta: userCash.toBase58(), userYesAta: userYes.toBase58() });
  }
  function lockedEconomics(snapshot: Awaited<ReturnType<typeof sourceSnapshot>>) {
    assert.deepEqual(sourceEconomics(snapshot), { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
      userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
    const raw = snapshot.state.accounts[3].account!;
    const decoded = program.coder.accounts.decode("order", Buffer.from(raw.dataHex, "hex"));
    assert.deepEqual(decoded.state, { cancelRequested: {} });
    assert.equal(decoded.cancellationRequested, true); assert.equal(decoded.acceptedReceipt, null);
  }
  async function sourceUnchanged(label: string) {
    const after = await sourceSnapshot();
    assert.deepEqual(after.state, locked.state, "All protocol/token data, rent, native balances, nonce and program history stay unchanged");
    lockedEconomics(after);
    evidence.stages[label] = { snapshot: after, economics: sourceEconomics(after), exactStateUnchanged: true };
    return after;
  }
  async function permanentRecord() {
    const actual = await settlement.getFunction("orderRecord").staticCall(hex(expectedId));
    assert.equal(settlement.interface.encodeFunctionData("cancel", [hex(expectedId), actual.terms]),
      settlement.interface.encodeFunctionData("cancel", [hex(expectedId), expectedTerms]));
    assert.equal(actual.termsHash, hex(expectedTermsHash)); assert.equal(actual.status, 2n);
    assert.equal(actual.filledQuantity, 0n); assert.equal(actual.receiptHash, expectedReceiptHash);
    return settlement.interface.encodeFunctionResult("orderRecord", [actual]);
  }
  async function verifyTransaction(hash: string, method: "cancel" | "execute", status: 0 | 1, event: boolean, nativeBefore: bigint) {
    const receipt = await provider.waitForTransaction(hash, 1, 60_000); assert.ok(receipt); assert.equal(receipt.status, status);
    const actualReceipt = await provider.send("eth_getTransactionReceipt", [hash]);
    assert.equal(actualReceipt.status, toQuantity(status)); assert.equal(actualReceipt.transactionHash, hash);
    const transaction = await provider.send("eth_getTransactionByHash", [hash]);
    assert.equal(transaction.from, agreement.evm.configuration.evmOperator);
    assert.equal(transaction.to, agreement.evm.configuration.settlement);
    assert.equal(transaction.value, "0x0"); assert.equal(BigInt(transaction.chainId), BigInt(evm.chainId));
    assert.equal(transaction.input, settlement.interface.encodeFunctionData(method, [hex(expectedId), expectedTerms]));
    const inclusion = await block(actualReceipt.blockNumber); assert.equal(inclusion.hash, actualReceipt.blockHash);
    assert.deepEqual(await block(), inclusion, "Anvil inclusion must be head before test mining");
    const events = receipt.logs.filter((log) => log.address.toLowerCase() === agreement.evm.configuration.settlement)
      .map((log) => settlement.interface.parseLog(log));
    if (event) {
      assert.equal(receipt.logs.length, 1); assert.equal(events.length, 1); assert.equal(events[0]?.name, "TerminalRecorded");
      assert.deepEqual(Array.from(events[0]!.args), [hex(expectedId), hex(expectedTermsHash), 2n, 0n, expectedReceiptHash]);
    } else assert.equal(receipt.logs.length, 0, "No new terminal, token, allowance or venue event");
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const nativeAfter = await provider.getBalance(evm.roles.operator); assert.equal(nativeAfter, nativeBefore - gasCost);
    const economic = await economicState(); cancelledEconomics(economic.state);
    const saved = { transactionHash: hash, method, receipt: actualReceipt, transaction, inclusion,
      events: events.map((parsed) => ({ name: parsed!.name, args: Array.from(parsed!.args) })),
      gas: { gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice, gasCost, nativeBefore, nativeAfter }, economics: economic };
    evidence.stages[`${method}-${hash}`] = saved; persist();
    return saved;
  }
  async function observe(label: string, hash: string, additionalBlocks: 0 | 1 | 2) {
    const at = await block(); const calls: { method: TerminalReadMethod; params: unknown[]; response?: unknown }[] = [];
    const providerStart = observerProviderCalls.length, forwardStart = moduleCalls.length;
    const adapter: TerminalObservationRpc = { async send(method, params) {
      assert.ok(observerMethods.includes(method));
      const call: typeof calls[number] = { method, params: structuredClone(params) }; calls.push(call);
      const response = await provider.send(method, params); call.response = structuredClone(response); return response;
    } };
    observing = true;
    let result;
    try {
      result = await observeTerminalOutcome({ provider: adapter, expectedConfiguration: agreement,
        orderId: hex(expectedId) as Bytes32Hex, termsHash: hex(expectedTermsHash) as Bytes32Hex,
        terms: expectedTerms as EvmTerms, transactionHash: hash });
    } finally { observing = false; }
    evidence.stages[label] = { transactionHash: hash, head: at, decision: result, calls,
      sourceRpcCalls: 0, submissions: 0, mining: 0 };
    persist();
    assert.deepEqual(await block(), at, "Observer must never mine");
    assert.equal(moduleCalls.length, forwardStart);
    assert.deepEqual(observerProviderCalls.slice(providerStart), calls.map((call) => call.method));
    assert.equal(at.number, firstTransaction.inclusion.number + BigInt(additionalBlocks));
    if (additionalBlocks < 2) {
      assert.deepEqual(result, { kind: "NotConfirmed", reason: "InsufficientAdditionalBlocks" });
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"]);
    } else {
      assert.deepEqual(result, { kind: "Confirmed", orderId: hex(expectedId), termsHash: hex(expectedTermsHash), terms: expectedTerms,
        receipt: { termsHash: hex(expectedTermsHash), terminal: 2, filledQuantity: 0n }, receiptHash: expectedReceiptHash,
        transactionHash: hash, inclusion: firstTransaction.inclusion, observationHead: at, additionalBlocks: 2n });
      assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber",
        "eth_getBlockByNumber", ...Array(6).fill("eth_call"), "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
      const reads = calls.filter((call) => call.method === "eth_call");
      for (const [index, hash] of [firstTransaction.inclusion.hash, at.hash].entries()) {
        assert.deepEqual(reads.slice(index * 3, index * 3 + 3).map((call) => call.params[1]), Array(3).fill({ blockHash: hash, requireCanonical: true }));
        assert.deepEqual(reads.slice(index * 3, index * 3 + 3).map((call) => call.params[0]), ["domain", "operator", "orderRecord"].map((name) => ({
          to: agreement.evm.configuration.settlement,
          data: settlement.interface.encodeFunctionData(name, name === "orderRecord" ? [hex(expectedId)] : []) })));
      }
    }
    assert.equal(await permanentRecord(), permanentCancelled); cancelledEconomics((await economicState()).state);
    await sourceUnchanged(`${label}-source`);
  }
  try {
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
      const path = join(runtime, "credentials", "cancellation-user.json");
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
      assert.equal(snapshot.state.accounts[10].account!.lamports, 1_000_000_000n);
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
      pending = await sourceSnapshot();
      const orderInfo = pending.state.accounts[3].account!;
      assert.equal(orderInfo.owner, programId.toBase58()); assert.equal(orderInfo.executable, false); assert.equal(orderInfo.space, 335);
      const expectedOrder = Buffer.concat([disc("Order"), config.toBuffer(), user.publicKey.toBuffer(), u64(nonce, true), bytes(evm.market),
        Buffer.from([0]), u64(cashAmount, true), u64(minimumShares, true), expectedId, expectedTermsHash, userCash.toBuffer(), userYes.toBuffer(),
        escrow.toBuffer(), Buffer.from([0, 0, 0, orderBump, escrowBump]), Buffer.alloc(41)]);
      assert.equal(orderInfo.dataHex, expectedOrder.toString("hex"));
      assert.equal(pending.state.accounts[2].account!.owner, programId.toBase58());
      assert.equal(pending.state.accounts[2].account!.dataHex, Buffer.concat([disc("UserNonce"), config.toBuffer(), user.publicKey.toBuffer(),
        u64(1n, true), Buffer.from([userBump])]).toString("hex"));
      const accountingBytes = Buffer.from(agreement.solana.config.dataHex, "hex");
      assert.equal(pending.state.accounts[0].account!.dataHex, accountingBytes.toString("hex"));
      const ledger = Buffer.concat([disc("Accounting"), config.toBuffer(), u64(cashAmount, true), Buffer.alloc(56), Buffer.from([source.bumps.accounting])]);
      assert.equal(pending.state.accounts[1].account!.dataHex, ledger.toString("hex"));
      const decoded = program.coder.accounts.decode("order", expectedOrder);
      assert.deepEqual(decoded.state, { pending: {} }); assert.equal(decoded.cancellationRequested, false); assert.equal(decoded.acceptedReceipt, null);
      const info = await connection.getAccountInfo(escrow, { commitment: "finalized", minContextSlot: creationSlot }); assert.ok(info);
      const token = unpackAccount(escrow, info, TOKEN_PROGRAM_ID);
      assert.ok(token.owner.equals(order) && token.mint.equals(cashMint)); assert.equal(token.delegate, null); assert.equal(token.closeAuthority, null);
      assert.equal(token.isInitialized, true); assert.equal(token.isFrozen, false); assert.equal(token.isNative, false);
      assert.deepEqual(sourceEconomics(pending), { userCash: 15_000_000n, escrow: 10_000_000n, cashSupply: 25_000_000n,
        userYes: 0n, yesSupply: 0n, executorCash: 0n, counters: [10_000_000n, 0n, 0n, 0n] });
      assert.equal(pending.state.protocolAccounts.length, 4);
      evidence.stages.creation = { ...creation, snapshot: pending, economics: sourceEconomics(pending), nextNonce: 1n,
        cancellationRequested: false, acceptedReceipt: null, state: "Pending" };
    });
    await check("independent Pending observation and allocated account rent match the finalized deposit", async () => {
      const actual = await readFinalizedPendingOrder({ ...input(), minFinalizedSlot: creationSlot });
      assert.equal(actual.state, "Pending"); assert.ok(actual.contextSlot >= creationSlot);
      assert.equal(actual.orderId, hex(expectedId)); assert.equal(actual.termsHash, hex(expectedTermsHash));
      assert.deepEqual(actual.terms, expectedTerms); assert.equal(actual.escrowBalance, cashAmount);
      for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const account = pending.state.accounts[index].account!;
        assert.equal(account.lamports, safeLamports(await connection.getMinimumBalanceForRentExemption(account.space, "finalized")));
      }
      evidence.stages.pendingReader = actual;
    });
    await check("actual request_cancel is signed only by the original user, changes only intent and charges only fees", async () => {
      const before = await sourceSnapshot(); assert.deepEqual(before.state, pending.state);
      const instruction = await program.methods.requestCancel(new BN(nonce.toString()), [...expectedTermsHash])
        .accountsStrict({ user: user.publicKey, config, order }).instruction();
      assert.ok(instruction.programId.equals(programId));
      assert.deepEqual(instruction.keys.map((meta) => ({ address: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable })), [
        { address: user.publicKey.toBase58(), signer: true, writable: false },
        { address: config.toBase58(), signer: false, writable: false },
        { address: order.toBase58(), signer: false, writable: true },
      ]);
      const expectedData = Buffer.concat([sha(Buffer.from("global:request_cancel")).subarray(0, 8), u64(nonce, true), expectedTermsHash]);
      assert.deepEqual(instruction.data, expectedData, "Independent instruction discriminator, nonce and expected hash");
      const cancellation = await submit([instruction], user); cancellationSlot = cancellation.finalizedSlot;
      assert.deepEqual(cancellation.requiredSigners, [user.publicKey.toBase58()]);
      assert.deepEqual(cancellation.instructions, [{ program: programId.toBase58(),
        accounts: [user.publicKey.toBase58(), config.toBase58(), order.toBase58()], dataHex: expectedData.toString("hex") }]);
      assert.deepEqual(cancellation.events, ["cancellationRequested"]);
      assert.deepEqual(cancellation.eventData, [{ name: "cancellationRequested", data: {
        config: config.toBase58(), user: user.publicKey.toBase58(), order: order.toBase58(), nonce: nonce.toString(),
        orderId: Array.from(expectedId), termsHash: Array.from(expectedTermsHash) } }]);
      assert.equal(cancellation.innerInstructions.length, 0, "No SPL or other CPI");
      assert.deepEqual(cancellation.logs?.filter((log) => /^Program .* invoke/.test(log)), [`Program ${programId.toBase58()} invoke [1]`]);
      assert.equal(cancellation.payerBalances.before, before.state.accounts[10].account!.lamports);
      assert.equal(cancellation.payerBalances.after, cancellation.payerBalances.before! - cancellation.fee);
      locked = await sourceSnapshot(); lockedEconomics(locked);
      const expectedAccounts = structuredClone(before.state.accounts);
      expectedAccounts[10].account!.lamports -= cancellation.fee;
      const expectedOrder = Buffer.from(expectedAccounts[3].account!.dataHex, "hex");
      assert.deepEqual(Array.from(expectedOrder.subarray(289, 292)), [0, 0, 0]);
      expectedOrder[289] = 1; expectedOrder[290] = 1;
      expectedAccounts[3].account!.dataHex = expectedOrder.toString("hex");
      assert.deepEqual(locked.state.accounts, expectedAccounts, "Immutable terms, nonce, escrow, mints, Accounting and rent are unchanged");
      const expectedProtocol = structuredClone(before.state.protocolAccounts);
      expectedProtocol.find((item) => item.address === order.toBase58())!.account!.dataHex = expectedOrder.toString("hex");
      assert.deepEqual(locked.state.protocolAccounts, expectedProtocol);
      assert.deepEqual(locked.state.tokens, before.state.tokens);
      assert.equal(locked.state.signatures.length, before.state.signatures.length + 1);
      assert.deepEqual(locked.state.signatures[0], { signature: cancellation.signature, slot: cancellationSlot, err: null, confirmationStatus: "finalized" });
      assert.deepEqual(locked.state.signatures.slice(1), before.state.signatures);
      evidence.stages.cancellation = { ...cancellation, instructionArguments: { nonce, expectedTermsHash: hex(expectedTermsHash) },
        before, after: locked, economicsBefore: sourceEconomics(before), economicsAfter: sourceEconomics(locked),
        state: "CancelRequested", cancellationRequested: true, acceptedReceipt: null, noCpi: true };
    });
    await check("finalized cancellation reader uses the cancellation slot and independent full order expectations", async () => {
      const actual = await readFinalizedCancellationRequest(input()); verifySourceRequest(actual);
      evidence.stages.cancellationReader = actual;
      await sourceUnchanged("sourceAfterReader");
    });
    await check("fresh destination is Unseen with exact setup economics before cancellation forwarding", async () => {
      const before = await economicState(); const { record, ...economic } = before.state;
      assert.equal(record.status, 0n); assert.equal(record.termsHash, hex(Buffer.alloc(32)));
      assert.equal(record.filledQuantity, 0n); assert.equal(record.receiptHash, hex(Buffer.alloc(32)));
      cancelledEconomics({ ...economic, record: { terms: expectedTerms, termsHash: hex(expectedTermsHash), status: 2n,
        filledQuantity: 0n, receiptHash: expectedReceiptHash } });
      assert.equal(before.blockNumber, 9, "No order-forwarding stage or purchase has run");
      evidence.stages.beforeForwarding = before;
      await sourceUnchanged("sourceBeforeForwarding");
    });
    await check("configured forwarder submits exact cancel calldata, one permanent Cancelled event and zero economic effects", async () => {
      const before = await economicState(); const nativeBefore = await provider.getBalance(evm.roles.operator);
      const start = moduleCalls.length;
      const submission = await forward(); verifySourceRequest(submission.sourceRequest);
      const calls = moduleCalls.slice(start);
      assert.equal(calls.filter((call) => call.chain === "Solana").length, 1);
      assert.equal(calls.filter((call) => call.method === "eth_sendTransaction").length, 1);
      firstTransaction = await verifyTransaction(submission.transactionHash, "cancel", 1, true, nativeBefore);
      permanentCancelled = await permanentRecord();
      const { record: _beforeRecord, ...beforeEconomics } = before.state;
      const { record: _afterRecord, ...afterEconomics } = firstTransaction.economics.state;
      assert.deepEqual(afterEconomics, beforeEconomics);
      assert.equal((await settlement.queryFilter(settlement.filters.TerminalRecorded(hex(expectedId)), 0, "latest")).length, 1);
      evidence.stages.forwarding = { submission, calls, before, after: firstTransaction, permanentCancelled };
      await sourceUnchanged("sourceAfterDestinationCancellation");
    });
    await check("inclusion N remains NotConfirmed and cannot refund source escrow", async () => {
      await observe("cancelledAtN", firstTransaction.transactionHash, 0);
    });
    await check("one additional test-mined block N+1 remains NotConfirmed", async () => {
      await provider.send("evm_mine", []);
      await observe("cancelledAtNPlus1", firstTransaction.transactionHash, 1);
    });
    await check("two additional test-mined blocks N+2 confirm exact canonical Cancelled receipt without source delivery", async () => {
      await provider.send("evm_mine", []);
      await observe("cancelledAtNPlus2", firstTransaction.transactionHash, 2);
    });
    await check("one explicit cancellation-forwarding replay succeeds with identical permanent record and no economic effects", async () => {
      const before = await economicState(); const nativeBefore = await provider.getBalance(evm.roles.operator);
      const start = moduleCalls.length;
      const submission = await forward(); verifySourceRequest(submission.sourceRequest);
      assert.notEqual(submission.transactionHash, firstTransaction.transactionHash);
      const replay = await verifyTransaction(submission.transactionHash, "cancel", 1, false, nativeBefore);
      const calls = moduleCalls.slice(start);
      assert.equal(calls.filter((call) => call.chain === "Solana").length, 1);
      assert.equal(calls.filter((call) => call.method === "eth_sendTransaction").length, 1);
      assert.equal(await permanentRecord(), permanentCancelled); assert.deepEqual(replay.economics.state, before.state);
      assert.equal((await settlement.queryFilter(settlement.filters.TerminalRecorded(hex(expectedId)), 0, "latest")).length, 1);
      evidence.stages.replay = { submission, calls, before, after: replay, newEvents: 0, automaticRecovery: false };
      await sourceUnchanged("sourceAfterReplay");
    });
    await check("explicit gas-limited late execute is mined with status 0 and exact OrderCancelled failure", async () => {
      const before = await economicState(); const nativeBefore = await provider.getBalance(evm.roles.operator);
      const transaction = await operator.sendTransaction({ to: evm.contracts.settlement,
        data: settlement.interface.encodeFunctionData("execute", [hex(expectedId), expectedTerms]), gasLimit: 1_000_000n });
      const failure = await verifyTransaction(transaction.hash, "execute", 0, false, nativeBefore);
      assert.equal(BigInt(failure.transaction.gas), 1_000_000n);
      const trace = await provider.send("debug_traceTransaction", [transaction.hash, { disableStorage: true, disableMemory: true, disableStack: true }]);
      const expectedRevert = settlement.interface.encodeErrorResult("OrderCancelled", [hex(expectedId)]);
      evidence.stages.lateExecution = { ...failure, expectedError: "OrderCancelled", expectedRevert, failed: trace.failed, returnValue: trace.returnValue };
      persist(); assert.equal(trace.failed, true);
      assert.equal(`0x${String(trace.returnValue).replace(/^0x/, "")}`, expectedRevert);
      assert.equal(await permanentRecord(), permanentCancelled); assert.deepEqual(failure.economics.state, before.state);
      await sourceUnchanged("sourceAfterRejectedLateExecution");
    });
    await check("wrong configured signer input rejects before RPC/submission without operator nonce or source changes", async () => {
      const before = await economicState(); const start = moduleCalls.length;
      const nonces = async () => Promise.all([evm.roles.operator, evm.roles.executor].map((address) => provider.send("eth_getTransactionCount", [address, "pending"])));
      const balances = async () => Promise.all([evm.roles.operator, evm.roles.executor].map((address) => provider.getBalance(address)));
      const nonceBefore = await nonces(), nativeBefore = await balances();
      await assert.rejects(forward(wrongOperator), /Operator signer differs from the configured EVM operator/);
      assert.equal(moduleCalls.length, start, "Wrong signer causes no RPC or submission");
      assert.deepEqual(await nonces(), nonceBefore); assert.deepEqual(await balances(), nativeBefore);
      assert.deepEqual(await economicState(), before);
      evidence.stages.wrongSigner = { address: evm.roles.executor, rejected: true, submissions: 0,
        reason: "Operator signer differs from the configured EVM operator", nonceBefore, nonceAfter: await nonces(), nativeBefore, nativeAfter: await balances() };
      await sourceUnchanged("sourceAfterWrongSigner");
    });
    await check("final source CancelRequested remains locked with no accepted receipt; destination record stays permanently Cancelled", async () => {
      const after = await sourceUnchanged("sourceFinal");
      const actual = await readFinalizedCancellationRequest(input()); verifySourceRequest(actual);
      const economic = sourceEconomics(after);
      assert.equal(economic.cashSupply, economic.userCash + economic.escrow + economic.executorCash);
      assert.equal(economic.counters[0], economic.escrow + economic.counters[1] + economic.counters[2]);
      const finalEvm = await economicState(); cancelledEconomics(finalEvm.state);
      assert.equal(await permanentRecord(), permanentCancelled);
      const events = await settlement.queryFilter(settlement.filters.TerminalRecorded(), 0, "latest"); assert.equal(events.length, 1);
      assert.equal(moduleCalls.filter((call) => call.method === "eth_sendTransaction").length, 2, "Exactly two explicit forwarder submissions");
      evidence.stages.finalBoundary = { sourceBefore: locked, sourceAfter: after, sourceEconomics: economic, reader: actual,
        evm: finalEvm, permanentCancelled, terminalEvents: events.map((event) => event.toJSON()), moduleCalls,
        receiptsDelivered: 0, sourceRefundInstructions: 0, sourceRefunds: 0n, sourceYesIssued: 0n,
        sourceExecutorReimbursed: 0n, lockedDeposit: cashAmount, acceptedReceipt: null, sourceState: "CancelRequested",
        observerMining: 0, observerSubmissions: 0, completedCrossChainCancellationSettlement: false };
    });
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally { provider.destroy(); persist(); }
});
