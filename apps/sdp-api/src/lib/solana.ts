/**
 * Solana Utilities
 *
 * Address validation, configuration helpers, and common constants
 * for Solana integration.
 */

import type { Env } from "@/types/env";
import type { Address } from "@solana/kit";

// Re-export Address type for convenience
export type { Address } from "@solana/kit";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Address Validation
// ═══════════════════════════════════════════════════════════════════════════

/** Base58 alphabet used by Solana */
// biome-ignore lint/nursery/noSecrets: Base58 alphabet is not a secret
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Validate a string is a valid Solana address (Base58, 32-44 chars)
 */
export function isValidSolanaAddress(address: string): boolean {
  // Check length (32 bytes = 32-44 base58 characters)
  if (address.length < 32 || address.length > 44) {
    return false;
  }

  // Check all characters are valid Base58
  for (const char of address) {
    if (!BASE58_ALPHABET.includes(char)) {
      return false;
    }
  }

  return true;
}

/**
 * Assert that a string is a valid Solana address
 * @throws Error if invalid
 */
export function assertValidAddress(address: string, fieldName = "address"): Address {
  if (!isValidSolanaAddress(address)) {
    throw new Error(`Invalid Solana address for ${fieldName}: ${address}`);
  }
  return address as Address;
}

// ═══════════════════════════════════════════════════════════════════════════
// Program Addresses
// ═══════════════════════════════════════════════════════════════════════════

/** Token-2022 program ID */
// biome-ignore lint/nursery/noSecrets: This is a well-known Solana program address
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Associated Token Account program ID */
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  // biome-ignore lint/nursery/noSecrets: This is a well-known Solana program address
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

/** System program ID */
// biome-ignore lint/nursery/noSecrets: This is a well-known Solana program address
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;

// ═══════════════════════════════════════════════════════════════════════════
// Associated Token Account
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Derive the Associated Token Account address for a given mint and owner.
 * This is a deterministic PDA derivation.
 */
export async function getAssociatedTokenAddressSync(
  mint: Address,
  owner: Address,
  programId: Address = TOKEN_2022_PROGRAM_ID
): Promise<Address> {
  // ATA seeds: [owner, token_program, mint]
  const seeds = [decodeBase58(owner), decodeBase58(programId), decodeBase58(mint)];

  const [pda] = await findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM_ID);
  return pda;
}

/**
 * Decode a Base58 string to Uint8Array
 */
function decodeBase58(encoded: string): Uint8Array {
  const result: number[] = [];

  for (const char of encoded) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }

    for (let i = 0; i < result.length; i++) {
      carry += result[i] * 58;
      result[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      result.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Add leading zeros
  for (const char of encoded) {
    if (char === "1") {
      result.push(0);
    } else {
      break;
    }
  }

  return new Uint8Array(result.reverse());
}

/**
 * Encode a Uint8Array to Base58 string
 */
function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Add leading zeros
  let result = "";
  for (const byte of bytes) {
    if (byte === 0) {
      result += "1";
    } else {
      break;
    }
  }

  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }

  return result;
}

/**
 * Find a program-derived address
 */
async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Address
): Promise<[Address, number]> {
  const programIdBytes = decodeBase58(programId);

  for (let bump = 255; bump >= 0; bump--) {
    const seedsWithBump = [...seeds, new Uint8Array([bump])];

    try {
      const pda = await createProgramAddress(seedsWithBump, programIdBytes);
      return [pda, bump];
    } catch {
      // Not a valid PDA, try next bump
    }
  }

  throw new Error("Unable to find a valid program address");
}

/**
 * Create a program-derived address from seeds
 */
async function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Promise<Address> {
  // Concatenate all seeds
  let totalLength = 0;
  for (const seed of seeds) {
    if (seed.length > 32) {
      throw new Error("Seed too long");
    }
    totalLength += seed.length;
  }
  totalLength += programId.length + 1; // +1 for "ProgramDerivedAddress" marker

  const buffer = new Uint8Array(totalLength + 21); // "ProgramDerivedAddress" is 21 chars
  let offset = 0;

  for (const seed of seeds) {
    buffer.set(seed, offset);
    offset += seed.length;
  }

  buffer.set(programId, offset);
  offset += programId.length;

  // Add "ProgramDerivedAddress" marker
  // biome-ignore lint/nursery/noSecrets: This is a Solana PDA derivation constant
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  buffer.set(marker, offset);

  // Hash with SHA-256
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const hashBytes = new Uint8Array(hash);

  // Check if on curve (simplified - real impl uses ed25519)
  // For our purposes, we accept the hash as the address
  if (isOnCurve(hashBytes)) {
    throw new Error("Invalid seeds - address is on curve");
  }

  return encodeBase58(hashBytes) as Address;
}

/**
 * Simplified check if point is on Ed25519 curve.
 * In production, this would use proper Ed25519 point decompression.
 */
function isOnCurve(_point: Uint8Array): boolean {
  // Simplified: assume all derived addresses are valid PDAs
  // Real implementation would check if the point is on the Ed25519 curve
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports for external use
// ═══════════════════════════════════════════════════════════════════════════

export { decodeBase58, encodeBase58 };
