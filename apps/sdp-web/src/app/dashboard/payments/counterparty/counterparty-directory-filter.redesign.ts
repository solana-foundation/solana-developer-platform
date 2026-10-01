import type { Counterparty } from "@sdp/types";

export type AddressFilter = "with" | "without";
export type EntityType = Counterparty["entityType"];

/**
 * The directory rows that match the search and filters. The search reads the name, external
 * ID, contact ID and saved addresses; `addressFilter` is left undefined while it is not offered.
 */
export function filterDirectory(
  counterparties: Counterparty[],
  addressesByCounterparty: ReadonlyMap<string, string[]>,
  {
    query,
    typeFilter,
    addressFilter,
  }: { query: string; typeFilter?: EntityType; addressFilter?: AddressFilter }
): Counterparty[] {
  const needle = query.trim().toLowerCase();
  return counterparties.filter((counterparty) => {
    const addresses = addressesByCounterparty.get(counterparty.id) ?? [];
    if (typeFilter !== undefined && counterparty.entityType !== typeFilter) return false;
    if (addressFilter === "with" && addresses.length === 0) return false;
    if (addressFilter === "without" && addresses.length > 0) return false;
    if (!needle) return true;
    return [counterparty.displayName, counterparty.externalId ?? "", counterparty.id, ...addresses]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}
