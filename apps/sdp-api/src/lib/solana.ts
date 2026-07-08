export { getSolanaConfig, resolveDefaultSolanaRpcUrl } from "@sdp/rpc";
// Import the narrow subpath (not the package root barrel): the root barrel pulls in
// token-2022, whose @solana/mosaic-sdk dependency fails to resolve under plain Node ESM.
export {
  type Address,
  assertIsAddress,
  assertValidAddress,
  isAddress,
} from "@sdp/solana/address";
