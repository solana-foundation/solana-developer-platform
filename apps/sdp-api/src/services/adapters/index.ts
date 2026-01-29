/**
 * Adapters Module
 *
 * Exports all adapters for the hexagonal architecture.
 * Adapters implement ports to connect domain to infrastructure.
 */

// Signing adapters (custody providers)
export {
  createSigningAdapter,
  createSigningAdapterFromEnv,
  createSigningAdapterFromConfig,
  FireblocksAdapter,
  LocalKeypairAdapter,
  type SigningProviderType,
  type SigningConfigRecord,
} from "./signing";

// Fee payment adapters (gasless transactions)
export {
  createFeePaymentAdapter,
  createKoraAdapter,
  createNativeAdapter,
  KoraAdapter,
  NativeAdapter,
  KoraClient,
  KoraClientError,
  type FeePaymentProviderType,
} from "./fee-payment";

// RPC adapters (blockchain interaction)
export { SolanaRpcAdapter } from "./rpc";
