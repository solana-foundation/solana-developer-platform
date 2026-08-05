import type { ComplianceProviderId, OrganizationRpcProvider, RampProviderId } from "@sdp/types";
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
  status: IntegrationStatus;
  /** Connection state could not be read; the status is entitlement-only. */
  statusUnknown?: boolean;
  descriptionKey?: MessageKey;
  custodyEntry?: CustodyProviderCatalogEntry;
  requestAccessUrl?: string;
}

export function isKnownIntegrationProvider(id: string): boolean {
  return (
    CUSTODY_PROVIDER_CATALOG.some((entry) => entry.id === id) ||
    ["alchemy", "helius", "nodit", "quicknode", "triton", "validationcloud", "default"].includes(
      id
    ) ||
    ["moonpay", "lightspark", "bvnk", "moneygram", "coinbase", "mural", "stripe"].includes(id) ||
    ["range", "elliptic", "trm", "chainalysis"].includes(id)
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
        status: "unavailable",
        statusUnknown: true,
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
