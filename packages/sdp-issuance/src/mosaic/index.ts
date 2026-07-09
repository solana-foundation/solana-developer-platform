/**
 * Mosaic Service
 *
 * Template-based token issuance using @solana/mosaic-sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and on-chain ABL integration.
 *
 * NOTE: importing this barrel loads @solana/mosaic-sdk, whose dist breaks
 * plain-Node ESM module graphs. In Node-only contexts import the mosaic-free
 * subpaths (`@sdp/issuance/mosaic/types`, `@sdp/issuance/mosaic/utils`)
 * instead.
 */

export {
  deriveAblListAddress,
  type MosaicIssuanceEnv,
  MosaicService,
  type MosaicServiceOptions,
  PACKET_DATA_SIZE,
} from "./service";
export * from "./types";
export { bigIntReplacer, safeStringify } from "./utils";
