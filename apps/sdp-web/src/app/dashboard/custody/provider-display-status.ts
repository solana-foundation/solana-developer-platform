import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
  type CustodyProviderDisplayStatus,
  type KnownCustodyProvider,
} from "./provider-catalog";

export interface CustodyProviderAvailability {
  entry: CustodyProviderCatalogEntry;
  status: CustodyProviderDisplayStatus;
  /** Present only while a gated provider still needs an access request. */
  requestAccessUrl?: string;
  isSelectable: boolean;
}

const SELECTABLE_STATUSES = new Set<CustodyProviderDisplayStatus>(["active", "available"]);

function resolveStatus(input: {
  entry: CustodyProviderCatalogEntry;
  isConnected: boolean;
  isEnabled: boolean;
}): CustodyProviderDisplayStatus {
  const { entry, isConnected, isEnabled } = input;

  // An organization that already holds a connection has passed every gate,
  // including the ones a catalog entry describes for everybody else.
  if (isConnected) {
    return "active";
  }
  if (isEnabled) {
    return "available";
  }
  if (entry.storedCredentialSetup.mode === "request_access") {
    return "request_access";
  }
  return "unavailable";
}

/**
 * Describes every provider the catalog is willing to display, so the setup flow
 * can show what exists and why it is or is not usable. Entitlement decides the
 * action, not whether the provider is worth knowing about.
 */
export function resolveCustodyProviderAvailability(input: {
  connectedProviders: readonly KnownCustodyProvider[];
  enabledProviders: readonly KnownCustodyProvider[];
}): CustodyProviderAvailability[] {
  const connected = new Set(input.connectedProviders);
  const enabled = new Set(input.enabledProviders);

  return CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).map((entry) => {
    const status = resolveStatus({
      entry,
      isConnected: connected.has(entry.id),
      isEnabled: enabled.has(entry.id),
    });

    return {
      entry,
      status,
      requestAccessUrl:
        status === "request_access" && entry.storedCredentialSetup.mode === "request_access"
          ? entry.storedCredentialSetup.requestAccessUrl
          : undefined,
      isSelectable: SELECTABLE_STATUSES.has(status),
    };
  });
}
