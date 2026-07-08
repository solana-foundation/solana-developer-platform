/**
 * Solana Address Helpers
 *
 * Address validation utilities shared across the platform.
 */

import { type Address, assertIsAddress } from "@solana/addresses";

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
