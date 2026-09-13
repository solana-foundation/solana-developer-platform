/**
 * Module-resolution hook: `@solana/zk-sdk/bundler` → `@solana/zk-sdk/node`.
 *
 * `@solana-program/token-2022`'s confidential-transfer helpers hardcode
 * `import ... from "@solana/zk-sdk/bundler"`, while `@solana/mosaic-sdk/_zk`
 * resolves to `@solana/zk-sdk/node` under the `node` export condition. There is
 * one physical `@solana/zk-sdk`, but `/node` and `/bundler` are separate entry
 * points that each instantiate their own wasm module — so an ElGamal keypair
 * built through one is rejected by the other with "expected instance of
 * ElGamalKeypair", and every confidential-transfer operation fails.
 *
 * `build-node.mjs`'s `zkSdkNodeWasmPlugin` collapses the two for the bundled
 * Docker build; this is the same redirect for anything that runs from source
 * under plain Node (the `tsx` dev server). The two must not drift apart.
 *
 * Rewriting only the specifier and forwarding the original `context` is what
 * makes this work: `parentURL` is preserved, so `/node` resolves from the same
 * importer — which is where `@solana/zk-sdk` actually sits in the tree.
 */

const BUNDLER_SPECIFIER = "@solana/zk-sdk/bundler";
const NODE_SPECIFIER = "@solana/zk-sdk/node";

export function resolve(specifier, context, nextResolve) {
  if (specifier === BUNDLER_SPECIFIER) {
    return nextResolve(NODE_SPECIFIER, context);
  }
  return nextResolve(specifier, context);
}
