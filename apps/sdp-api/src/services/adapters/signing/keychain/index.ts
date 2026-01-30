/**
 * Keychain Signing Adapters
 *
 * Adapters that wrap @solana/keychain-* packages to implement SigningPort.
 * Keychain provides the unified signing interface, custody backends provide the keys.
 *
 * Supported custody backends:
 * - Memory: In-memory keypair (development/testing)
 * - Fireblocks: Enterprise MPC custody (@solana/keychain-fireblocks)
 */

// Types
export type { KeychainFireblocksConfig } from "./types";

// Adapters
export { BaseKeychainAdapter } from "./base-keychain.adapter";
export { KeychainFireblocksAdapter } from "./keychain-fireblocks.adapter";
export { KeychainMemoryAdapter } from "./keychain-memory.adapter";
