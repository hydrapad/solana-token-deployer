import * as esbuild from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  // esbuild picks up the `browser` field map in web3.js, which swaps in the
  // browser-safe bundle instead of the node one.
  mainFields: ["browser", "module", "main"],
  target: ["chrome110", "firefox110", "safari16"],
  minify: !watch,
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
  // Metaplex's beet is CommonJS and touches Node's `process` global; bn.js
  // expects the Node `Buffer` global. Both are shimmed rather than polyfilled.
  inject: [
    path.join(root, "src/shims/process.ts"),
    path.join(root, "src/shims/buffer.ts"),
  ],
};

const CSS_MARKER = "/*__STYLES__*/";
const SCRIPT_MARKER = "/*__SCRIPT__*/";

/** Inline the bundled JS + stylesheet into one portable, double-clickable file. */
async function emit(bundleJs) {
  const css = await readFile(path.join(root, "src/styles.css"), "utf8");
  const shell = await readFile(path.join(root, "src/index.html"), "utf8");

  for (const marker of [CSS_MARKER, SCRIPT_MARKER]) {
    if (!shell.includes(marker)) {
      throw new Error(`src/index.html is missing the ${marker} placeholder.`);
    }
  }

  // Use replacer functions: the payloads contain `$&`-style sequences that
  // String.replace would otherwise interpret.
  const html = shell.replace(CSS_MARKER, () => css).replace(SCRIPT_MARKER, () => bundleJs);

  await mkdir(dist, { recursive: true });
  const outFile = path.join(dist, "sol-token-launcher.html");
  await writeFile(outFile, html);
  const kb = Buffer.byteLength(html) / 1024;
  console.log(`\n  Built dist/sol-token-launcher.html  (${kb.toFixed(0)} KB)\n`);
}

async function run() {
  if (!watch) {
    const result = await esbuild.build(buildOptions);
    await emit(result.outputFiles[0].text);
    return;
  }

  const ctx = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "emit",
        setup(b) {
          b.onEnd(async (result) => {
            const file = result.outputFiles?.[0];
            if (file) await emit(file.text);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log("\n  Watching src/ ...\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});