import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
import { COMPLIANCE_PROVIDERS, ORGANIZATION_RPC_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
} from "@/app/dashboard/custody/provider-catalog";
import type { CustodyProviderAvailability } from "@/app/dashboard/custody/provider-display-status";
import type { MessageKey } from "@/i18n/messages";
import type { IntegrationFamily } from "./integrations-filter";
import type { IntegrationEntry, IntegrationStatus } from "./integrations-status";

/**
 * Everything a provider detail page can say, resolved from the same inputs the
 * catalog reads. One shape across families; custody carries the extra
 * capability data the shared catalog models for it.
 */
export interface IntegrationDetail {
  family: IntegrationFamily;
  provider: string;
  label: string;
  /**
   * `unknown` only when the connection lookup failed, so the page can say it
   * cannot read the state rather than guessing one and offering a wrong action.
   */
  status: IntegrationStatus | "unknown";
  descriptionKey?: MessageKey;
  custodyEntry?: CustodyProviderCatalogEntry;
  requestAccessUrl?: string;
}

/**
 * Derived from the same constants the catalog renders from. Hand-written id
 * lists drifted silently — a newly added ramp got a card that then 404'd on
 * click, because nothing typed the literals against the provider unions.
 */
const KNOWN_NON_CUSTODY_PROVIDERS: ReadonlySet<string> = new Set<string>([
  ...ORGANIZATION_RPC_PROVIDERS,
  ...RAMP_PROVIDERS,
  ...COMPLIANCE_PROVIDERS,
]);

export function isKnownIntegrationProvider(id: string): boolean {
  return (
    CUSTODY_PROVIDER_CATALOG.some((entry) => entry.id === id) || KNOWN_NON_CUSTODY_PROVIDERS.has(id)
  );
}

export function resolveIntegrationDetail(input: {
  provider: string;
  custody: CustodyProviderAvailability[] | null;
  rpc: IntegrationEntry<OrganizationRpcProvider>[];
  ramps: IntegrationEntry<RampProviderId>[];
  compliance: IntegrationEntry<ComplianceProviderId>[];
}): IntegrationDetail | null {
  // A failed connection lookup must not turn a known custody provider into a
  // 404: the page renders from the catalog entry with its state marked
  // unknown, and offers no action that depends on the state it cannot see.
  if (input.custody === null) {
    const entry = CUSTODY_PROVIDER_CATALOG.find(
      (candidate) => candidate.id === input.provider && candidate.visible
    );
    if (entry) {
      return {
        family: "custody",
        provider: entry.id,
        label: entry.label,
        status: "unknown",
        descriptionKey: entry.descriptionKey,
        custodyEntry: entry,
      };
    }
  }

  const custodyMatch = (input.custody ?? []).find((entry) => entry.entry.id === input.provider);
  if (custodyMatch) {
    return {
      family: "custody",
      provider: custodyMatch.entry.id,
      label: custodyMatch.entry.label,
      status: custodyMatch.status,
      descriptionKey: custodyMatch.entry.descriptionKey,
      custodyEntry: custodyMatch.entry,
      requestAccessUrl:
        custodyMatch.status === "request_access" &&
        custodyMatch.entry.storedCredentialSetup.mode === "request_access"
          ? custodyMatch.entry.storedCredentialSetup.requestAccessUrl
          : undefined,
    };
  }

  for (const [family, entries] of [
    ["rpc", input.rpc],
    ["ramps", input.ramps],
    ["compliance", input.compliance],
  ] as const) {
    const match = (entries as IntegrationEntry[]).find(
      (entry) => entry.provider === input.provider
    );
    if (match) {
      return {
        family,
        provider: match.provider,
        label: match.label,
        status: match.status,
        descriptionKey: match.descriptionKey,
      };
    }
  }

  return null;
}
