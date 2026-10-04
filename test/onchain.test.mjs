/**
 * Runs REAL simulations on live Solana clusters using the same planDeploy()
 * and simulate() the browser uses.
 *
 * Simulation runs with sigVerify:false, so this needs no private key — just a
 * funded fee payer, which we borrow from a recent transaction. Passing here
 * means the on-chain programs genuinely accept these instructions.
 *
 * Usage: node test/onchain.test.mjs
 */
import * as esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(path.dirname(here), "node_modules", ".cache", "onchain.test.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "onchain.cases.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  logLevel: "error",
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __filename.replace(/[^/\\\\]+$/, '');",
    ].join("\n"),
  },
});

await import(pathToFileURL(outfile).href);