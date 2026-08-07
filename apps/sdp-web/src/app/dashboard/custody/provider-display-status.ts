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
  // Not enabled splits along the launch classification: a manual provider is
  // organization access the SDP team grants, a general provider is open to
  // everyone and only lacks credentials in this deployment. But "request
  // access" is a promise the page has to keep — a manual provider whose
  // catalog entry carries no request route would say access is requestable
  // while offering no way to request it, so until HOO-775 wires per-provider
  // routes those hold at not-configured instead.
  if (entry.availability === "manual") {
    return entry.storedCredentialSetup.mode === "request_access"
      ? "request_access"
      : "not_configured";
  }
  return "not_configured";
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

  return (
    CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible)
      .map((entry) => {
        const status = resolveStatus({
          entry,
          isConnected: connected.has(entry.id),
          isEnabled: enabled.has(entry.id),
        });

        return {
          entry,
          status,
          // Per-provider, environment-configurable, and only Fireblocks has
          // one today; wiring routes for the rest is HOO-775.
          requestAccessUrl:
            status === "request_access" && entry.storedCredentialSetup.mode === "request_access"
              ? entry.storedCredentialSetup.requestAccessUrl
              : undefined,
          isSelectable: SELECTABLE_STATUSES.has(status),
        };
      })
      // The local signer is a self-hosted deployment mode, not an integration an
      // organization can go and get — its copy even names a deployment env var.
      // Where the deployment runs one it is genuinely active or ready; where it
      // does not, naming it "not configured" would invite configuring it, so it
      // earns no row at all.
      .filter((provider) => provider.entry.id !== "local" || provider.status !== "not_configured")
  );
}
