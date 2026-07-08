import { getSolanaConfig, resolveDefaultSolanaRpcUrl } from "@sdp/rpc";
import { type Address, assertIsAddress } from "@solana/addresses";

export type { Address } from "@solana/addresses";
export { assertIsAddress, isAddress } from "@solana/addresses";
export { getSolanaConfig, resolveDefaultSolanaRpcUrl };

export function assertValidAddress(value: string, fieldName = "address"): Address {
  try {
    assertIsAddress(value);
    return value;
  } catch {
    throw new Error(`Invalid Solana address for ${fieldName}: ${value}`);
  }
}
