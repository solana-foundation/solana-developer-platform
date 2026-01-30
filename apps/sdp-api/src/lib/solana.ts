/**
 * Solana Configuration
 *
 * Environment-based configuration for Solana RPC connection.
 * All crypto utilities come from @solana/kit packages.
 */

import type { Env } from "@/types/env";
import { type Address, assertIsAddress } from "@solana/addresses";

// Re-export for convenience
export type { Address } from "@solana/addresses";
export { assertIsAddress, isAddress } from "@solana/addresses";

export interface SolanaConfig {
  rpcUrl: string;
  network: "devnet" | "mainnet-beta";
}

/**
 * Extract Solana configuration from environment
 */
export function getSolanaConfig(env: Env): SolanaConfig {
  const rpcUrl = env.SOLANA_RPC_URL;
  const network = env.SOLANA_NETWORK ?? "devnet";

  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL environment variable is not configured");
  }

  return { rpcUrl, network };
}

/**
 * Validate and return a Solana address.
 * Throws if the address is invalid.
 */
export function assertValidAddress(value: string, fieldName = "address"): Address {
  try {
    assertIsAddress(value);
    return value;
  } catch {
    throw new Error(`Invalid Solana address for ${fieldName}: ${value}`);
  }
}
