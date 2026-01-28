/**
 * Solana Signer Service
 *
 * Provides signing capabilities for Solana transactions.
 * Uses @solana/kit's KeyPairSigner for compatibility with the SDK.
 */

import type { Env } from "@/types/env";
import { getBase58Codec } from "@solana/codecs";
import { type Address, type KeyPairSigner, createKeyPairSignerFromBytes } from "@solana/kit";

const base58 = getBase58Codec();

// Re-export KeyPairSigner type for consumers
export type { KeyPairSigner };

// ═══════════════════════════════════════════════════════════════════════════
// Signer Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a transaction signer from a Base58-encoded Solana keypair.
 * The keypair should be 64 bytes: 32 byte private + 32 byte public.
 */
export async function createSignerFromBase58(privateKeyBase58: string): Promise<KeyPairSigner> {
  // codec.encode converts base58 string → bytes
  const secretKey = new Uint8Array(base58.encode(privateKeyBase58));

  // Solana keypair format: 64 bytes = 32 byte private + 32 byte public
  if (secretKey.length !== 64) {
    throw new Error(`Invalid keypair length: expected 64 bytes, got ${secretKey.length}`);
  }

  // Create signer using @solana/kit
  return createKeyPairSignerFromBytes(secretKey);
}

/**
 * Create a transaction signer from environment configuration.
 * In development, uses CUSTODY_PRIVATE_KEY.
 * In production, would route to custody provider based on configuration.
 */
export async function createSigner(env: Env): Promise<KeyPairSigner> {
  const privateKey = env.CUSTODY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("CUSTODY_PRIVATE_KEY environment variable is not configured");
  }

  return createSignerFromBase58(privateKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a signer controls a specific address
 */
export function signerControlsAddress(signer: KeyPairSigner, address: Address): boolean {
  return signer.address === address;
}

/**
 * Get the address from a signer
 */
export function getSignerAddress(signer: KeyPairSigner): Address {
  return signer.address;
}
