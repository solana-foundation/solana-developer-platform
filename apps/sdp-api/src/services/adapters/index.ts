/**
 * Adapters Module
 *
 * Exports all adapters for the hexagonal architecture.
 * Adapters implement ports to connect domain to infrastructure.
 */

// Signing adapters (custody providers via @solana/keychain)
export {
  createSigningAdapter,
  createSigningAdapterFromEnv,
  createSigningAdapterFromConfig,
  KeychainCoinbaseAdapter,
  KeychainDfnsAdapter,
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  KeychainPrivyAdapter,
  KeychainTurnkeyAdapter,
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
  type FeePaymentProviderType,
} from "./fee-payment";

// RPC adapters (blockchain interaction)
export { SolanaRpcAdapter } from "./rpc";
