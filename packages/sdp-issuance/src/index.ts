/**
 * @sdp/issuance
 *
 * Token issuance domain internals: Mosaic template-based token issuance and
 * the issuance template catalog.
 *
 * NOTE: importing this root barrel loads @solana/mosaic-sdk (via ./mosaic),
 * whose dist breaks plain-Node ESM module graphs. In Node-only contexts import
 * the narrow subpaths instead (`@sdp/issuance/templates`,
 * `@sdp/issuance/mosaic/types`, `@sdp/issuance/mosaic/utils`).
 */

export * from "./mosaic";
export * from "./templates";
