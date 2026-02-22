/**
 * Keychain Signing Adapters
 *
 * Adapters that wrap @solana/keychain-* packages to implement SigningPort.
 * Keychain provides the unified signing interface, custody backends provide the keys.
 *
 * Supported custody backends:
 * - Memory: In-memory keypair (development/testing)
 * - Fireblocks: Enterprise MPC custody (@solana/keychain-fireblocks)
 * - Privy: Hosted wallets via Privy API (@solana/keychain-privy)
 * - Coinbase CDP: Hosted wallets via Coinbase CDP API (@sdp/keychain-coinbase)
 */

// Types
export type {
  KeychainCoinbaseConfig,
  KeychainFireblocksConfig,
  KeychainPrivyConfig,
} from "./types";

// Adapters
export { BaseKeychainAdapter } from "./base-keychain.adapter";
export { KeychainCoinbaseAdapter } from "./keychain-coinbase.adapter";
export { KeychainFireblocksAdapter } from "./keychain-fireblocks.adapter";
export { KeychainMemoryAdapter } from "./keychain-memory.adapter";
export { KeychainPrivyAdapter } from "./keychain-privy.adapter";
