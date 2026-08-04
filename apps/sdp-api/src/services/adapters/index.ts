/**
 * Adapters Module
 *
 * Exports all adapters for the hexagonal architecture.
 * Adapters implement ports to connect domain to infrastructure.
 */

// Signing adapters (custody providers via @solana/keychain)
export {
  createSigningAdapter,
  createSigningAdapterFromConfig,
  createSigningAdapterFromEnv,
  KeychainCoinbaseAdapter,
  KeychainDfnsAdapter,
  KeychainFireblocksAdapter,
  KeychainIbmHavenAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  KeychainPrivyAdapter,
  KeychainTurnkeyAdapter,
  KeychainUtilaAdapter,
  type SigningConfigRecord,
  type SigningProviderType,
} from "./signing";
