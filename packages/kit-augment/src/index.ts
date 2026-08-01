/**
 * `@sdp/kit-augment` — shared `@solana/kit` version shim.
 *
 * `@codama/renderers-js` (2.3) references the `ExtendedClient` return type of
 * `extendClient` in the generated program-client plugin. The repo's pinned
 * `@solana/kit` (6.8) ships `extendClient` at runtime but not that type export
 * (it lands in kit 6.9+). Augment `@solana/kit` with a permissive definition so
 * generated program helpers type-check.
 *
 * This lives in ONE shared package (rather than a per-client `kit-augment.ts`) so
 * a consumer that imports MORE THAN ONE codama client — e.g. `sdp-api` pulling in
 * both `@sdp/spc-escrow` and `@sdp/spc-withdraw` — sees the `declare module`
 * exactly once. Two copies of an identical `export type` collide (type aliases
 * don't merge → TS2300 "Duplicate identifier"); a single shared module cannot.
 *
 * Imported for side effects by each client's `./index`. Remove this once the
 * repo's `@solana/kit` exports `ExtendedClient` natively.
 */

// Type-only reference so TS resolves `@solana/kit` as an existing module and treats
// the block below as an AUGMENTATION (not a fresh ambient module). No runtime cost.
import type {} from "@solana/kit";

declare module "@solana/kit" {
  // extendClient(client, ext) returns the client with `ext` merged in (ext keys win).
  export type ExtendedClient<TClient, TExtensions> = Omit<TClient, keyof TExtensions> & TExtensions;
}
