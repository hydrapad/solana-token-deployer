/**
 * Browser `Buffer` shim, backed by the `buffer` npm package.
 *
 * Some transitive dependencies (bn.js via @solana/buffer-layout) reference the
 * Node global `Buffer` directly. esbuild disables that bare import for browser
 * builds, so we inject the polyfill under the global name.
 */
import { Buffer as BufferPolyfill } from "buffer";

export const Buffer = BufferPolyfill;
export const transcode = (..._args: unknown[]): never => {
  throw new Error("transcode is not supported in the browser");
};