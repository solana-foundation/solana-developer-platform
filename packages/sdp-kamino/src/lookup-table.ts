import type { Address, AddressesByLookupTableAddress } from "@solana/kit";
import { fetchAddressesForLookupTables } from "@solana/kit";

/**
 * The system program address doubles as "no lookup table configured": a
 * VaultState is zero-initialised, and 32 zero bytes render as this base58
 * string. Reading it as a real table address would fetch the system program
 * account and fail decoding on every plan.
 */
const UNSET_LOOKUP_TABLE = "11111111111111111111111111111111";

/**
 * Resolve a vault's published lookup table to the address list compilation
 * needs, or to nothing when the table cannot help.
 *
 * BEST-EFFORT BY DESIGN: this is an exit path, and the lookup table is a
 * compression aid, not a correctness requirement. A vault whose table is
 * unset, missing, or unreadable still gets a plan. The API compiles it without
 * compression and rejects it only if the final transaction exceeds Solana's
 * packet limit. Failing earlier for a missing optimisation would invert the
 * priority ADR 0002 sets.
 *
 * An EMPTY result map (`{}`) is the "no table" answer; callers must not carry
 * an empty table into a plan's `lookupTables`, because the API would then
 * fetch it again for a compilation it cannot improve.
 */
export async function loadVaultLookupTableAddresses(
  rpc: Parameters<typeof fetchAddressesForLookupTables>[1],
  lookupTableAddress: Address | string | null | undefined
): Promise<AddressesByLookupTableAddress> {
  const table = String(lookupTableAddress ?? "");
  if (table === "" || table === UNSET_LOOKUP_TABLE) return {};
  try {
    const addressesByTable = await fetchAddressesForLookupTables([table as Address], rpc);
    const addresses = addressesByTable[table as Address];
    // A table with no entries compresses nothing; treat it as absent so the
    // plan does not advertise a lookup table the compiler cannot use.
    if (!addresses || addresses.length === 0) return {};
    return addressesByTable;
  } catch {
    return {};
  }
}
