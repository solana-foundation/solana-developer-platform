/**
 * Adapters Module
 *
 * Exports all adapters for the hexagonal architecture.
 * Adapters implement ports to connect domain to infrastructure.
 */

// Fee payment adapters (gasless transactions)
export {
  createFeePaymentAdapter,
  createKoraAdapter,
  createNativeAdapter,
  type FeePaymentProviderType,
  KoraAdapter,
  KoraClient,
  NativeAdapter,
} from "./fee-payment";
// RPC adapters (blockchain interaction)
export { SolanaRpcAdapter } from "./rpc";
// Signing adapters (custody providers via @solana/keychain)
export {
  createSigningAdapter,
  createSigningAdapterFromConfig,
  createSigningAdapterFromEnv,
  KeychainCoinbaseAdapter,
  KeychainDfnsAdapter,
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  KeychainPrivyAdapter,
  KeychainTurnkeyAdapter,
  type SigningConfigRecord,
  type SigningProviderType,
} from "./signing";
