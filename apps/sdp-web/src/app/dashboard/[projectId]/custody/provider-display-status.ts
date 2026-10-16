import type {
  AvailableCustodyModes,
  ProjectCustodyAvailability,
} from "@/lib/provider-availability";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
  type CustodyProviderDisplayStatus,
  type KnownCustodyProvider,
} from "./provider-catalog";

export interface CustodyProviderAvailability {
  entry: CustodyProviderCatalogEntry;
  status: CustodyProviderDisplayStatus;
  /** The custody modes the project may set this provider up in. */
  modes: AvailableCustodyModes;
}

/**
 * The custody providers the project can use, in catalog order, each with the
 * modes it may be set up in and whether it already is. A provider missing from
 * `custodyAvailability`, or the catalog does not display, gets no row: an
 * unavailable provider is hidden, not shown disabled.
 *
 * @param input - The project's custody state.
 * @param input.connectedProviders - Providers with an active custody config in the project.
 * @param input.custodyAvailability - The project's custody provider availability entries.
 * @returns One row per custody provider the project can use.
 */
export function resolveCustodyProviderAvailability(input: {
  connectedProviders: readonly KnownCustodyProvider[];
  custodyAvailability: readonly ProjectCustodyAvailability[];
}): CustodyProviderAvailability[] {
  const connected = new Set(input.connectedProviders);
  const modesByProvider = new Map(
    input.custodyAvailability.map((availability) => [availability.provider, availability.modes])
  );

  return CUSTODY_PROVIDER_CATALOG.flatMap((entry): CustodyProviderAvailability[] => {
    const modes = modesByProvider.get(entry.id);
    if (!entry.visible || modes === undefined) {
      return [];
    }
    return [{ entry, status: connected.has(entry.id) ? "active" : "available", modes }];
  });
}
