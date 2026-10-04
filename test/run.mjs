// Bundles the TypeScript tests with esbuild, then runs them on Node.
import * as esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// run.mjs lives in test/, so the project root is one level up.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const outfile = path.join(root, "node_modules", ".cache", "plan.test.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "plan.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile,
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  // The CommonJS builds inside web3.js call require() at load time.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outfile, { force: true });
}