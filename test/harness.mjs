/**
 * Builds dist/__test.html: the real app with a mocked JSON-RPC endpoint and a
 * mock wallet injected *before* the bundle runs.
 *
 * web3.js captures `globalThis.fetch` when its module is first evaluated, so the
 * stub has to be installed ahead of the app script rather than after load.
 *
 * Usage: node test/harness.mjs   then open http://localhost:4173/__test.html
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const built = path.join(root, "dist", "sol-token-launcher.html");
const out = path.join(root, "dist", "__test.html");

const PRELUDE = `
<script>
(function () {
  var BLOCKHASH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  // A real 64-byte signature in base58; web3.js validates the length it gets back.
  var SIG = "qtstFmGTeYMvMzbdkCymFj2xvXsZV7jqa6guP2sgP9E6av1Lva5SM5GCbumRzkRiV4M2jjiFUuWyzSLYwUpPSwj";
  var CALLS = [];
  var realFetch = window.fetch.bind(window);

  function reply(method, params) {
    CALLS.push(method);
    switch (method) {
      case "getSlot": return 400000000;
      case "getVersion": return { "solana-core": "2.1.0", "feature-set": 1 };
      case "getBalance": return { context: { slot: 400000000 }, value: 5000000000 };
      case "getMinimumBalanceForRentExemption": {
        var space = (params && params[0]) || 0;
        if (space === 6791) return 11356000;
        if (space === 82) return 1461600;
        return 2039280;
      }
      case "getLatestBlockhash":
        return { context: { slot: 400000000 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 400001000 } };
      case "simulateTransaction":
        return { context: { slot: 400000000 }, value: { err: null, logs: ["Program log: mock"], accounts: null, unitsConsumed: 9000 } };
      case "sendTransaction": return SIG;
      case "getSignatureStatuses":
        return { context: { slot: 400000000 }, value: [{ slot: 400000000, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: "confirmed" }] };
      default: return null;
    }
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : ((input && input.url) || "");
    var body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
    if (body && body.method) {
      var result;
      if (body.method === "simulateTransaction" && window.__failSim) {
        result = { context: { slot: 400000000 }, value: { err: { InstructionError: [2, "Custom program error: 0x1"] }, logs: [] } };
      } else if (body.method === "sendTransaction" && window.__failSend) {
        return Promise.resolve(new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: window.__failSend } }),
          { status: 500, headers: { "content-type": "application/json" } }
        ));
      } else if (body.method === "getBalance" && window.__balance !== undefined) {
        result = { context: { slot: 400000000 }, value: window.__balance };
      } else {
        result = reply(body.method, body.params);
      }
      return Promise.resolve(new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result }),
        { status: 200, headers: { "content-type": "application/json" } }
      ));
    }
    return realFetch(input, init);
  };

  window.__rpcCalls = function () { return CALLS.slice(); };
  window.__failSim = null;
  window.__failSend = null;
  window.__balance = 5000000000;
  window.__rejectSign = false;

  var zero = function (s) { return !s || Array.prototype.every.call(s, function (b) { return b === 0; }); };
  window.__signed = null;

  window.phantom = {
    isPhantom: true,
    publicKey: null,
    connect: function () {
      return Promise.resolve({ publicKey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });
    },
    signTransaction: function (tx) {
      window.__signed = {
        numRequired: tx.message.header.numRequiredSignatures,
        signerKeys: tx.message.staticAccountKeys
          .slice(0, tx.message.header.numRequiredSignatures)
          .map(function (k) { return k.toBase58(); }),
        instructionCount: tx.message.compiledInstructions.length,
        mintSignaturePresent: !zero(tx.signatures[1]),
        payerSignatureBlank: zero(tx.signatures[0]),
        serializedBytes: tx.serialize().length,
      };
      if (window.__rejectSign) {
        return Promise.reject(new Error("User rejected the request."));
      }
      tx.signatures[0] = new Uint8Array(64).fill(7);
      return Promise.resolve(tx);
    },
    disconnect: function () { return Promise.resolve(); },
    on: function () {},
  };
})();
</script>
`;

let html = await readFile(built, "utf8");

// The app bundle sits in the final <script> block; the stub must come first.
const lastScript = html.lastIndexOf("<script>");
if (lastScript < 0) throw new Error("no <script> found in the built file");

html = html.slice(0, lastScript) + PRELUDE + html.slice(lastScript);
await writeFile(out, html);

console.log("wrote dist/__test.html");