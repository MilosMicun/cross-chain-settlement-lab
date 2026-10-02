import assert from "node:assert/strict";
import { AnchorProvider, Program } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { JsonRpcProvider } from "ethers";

// Import/constructor checks only. No RPC request or business operation is sent.
assert.equal(typeof AnchorProvider, "function");
assert.equal(typeof Program, "function");
assert.ok(TOKEN_PROGRAM_ID instanceof PublicKey);
const source = new Connection("http://127.0.0.1:18899", "finalized");
assert.equal(source.rpcEndpoint, "http://127.0.0.1:18899");
const destination = new JsonRpcProvider("http://127.0.0.1:18545", 31337, {
  staticNetwork: true,
});
destination.destroy();
console.log("PASS: Anchor, legacy Solana/SPL, and EVM client imports (no network requests)");
