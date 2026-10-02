/**
 * Solana Address Helpers
 *
 * Address validation utilities shared across the platform.
 */

import {
  type Address,
  assertIsAddress,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/addresses";

export type { Address } from "@solana/addresses";
export { assertIsAddress, isAddress } from "@solana/addresses";

export function assertValidAddress(value: string, fieldName = "address"): Address {
  try {
    assertIsAddress(value);
    return value;
  } catch {
    throw new Error(`Invalid Solana address for ${fieldName}: ${value}`);
  }
}

/** Derive the exact token account used by owner-associated transfer paths. */
export async function deriveAssociatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({
    // biome-ignore lint/security/noSecrets: public associated token program address.
    programAddress: assertValidAddress("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [owner, tokenProgram, mint].map((value) => encoder.encode(assertValidAddress(value))),
  });
  return account;
}
