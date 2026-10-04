/**
 * Minimal `process` shim for the browser bundle.
 *
 * @metaplex-foundation/beet ships as CommonJS and reaches for Node's `assert`
 * and `util`, both of which read `process` off the global scope. esbuild has no
 * polyfills for browser builds, so we inject this instead.
 */
const noop = () => {};

export const process = {
  env: {} as Record<string, string | undefined>,
  browser: true,
  platform: "browser" as const,
  version: "v20.0.0",
  versions: { node: "20.0.0" },
  pid: 1,
  argv: [] as string[],
  throwDeprecation: false,
  traceDeprecation: false,
  noDeprecation: false,
  emitWarning: noop,
  cwd: () => "/",
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => fn(...args));
  },
  stdout: { write: noop, isTTY: false, columns: 80 },
  stderr: { write: noop, isTTY: false, columns: 80, getColorDepth: () => 1 },
};