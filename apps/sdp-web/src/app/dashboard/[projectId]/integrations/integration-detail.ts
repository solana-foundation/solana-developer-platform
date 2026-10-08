import type { ComplianceProviderId, RampProviderId } from "@sdp/types";
// biome-ignore lint/style/noRestrictedImports: recognises provider ids for routing; visibility is gated in integration-feature-gates.ts
import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import type { CustodyProviderAvailability } from "@/app/dashboard/[projectId]/custody/provider-display-status";
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
  descriptionKey?: MessageKey;
  custodyEntry?: CustodyProviderCatalogEntry;
}

/**
 * Derived from the same constants the catalog renders from. Hand-written id
 * lists drifted silently — a newly added ramp got a card that then 404'd on
 * click, because nothing typed the literals against the provider unions.
 */
const KNOWN_NON_CUSTODY_PROVIDERS: ReadonlySet<string> = new Set<string>([
  ...RAMP_PROVIDERS,
  ...COMPLIANCE_PROVIDERS,
]);

export function isKnownIntegrationProvider(id: string): boolean {
  return (
    CUSTODY_PROVIDER_CATALOG.some((entry) => entry.id === id) || KNOWN_NON_CUSTODY_PROVIDERS.has(id)
  );
}

/**
 * Finds the provider in the family inputs the catalog renders from.
 *
 * @param input - The provider and the resolved family entries.
 * @param input.provider - The provider id from the route.
 * @param input.custody - Custody availability.
 * @param input.ramps - Ramp integration entries.
 * @param input.compliance - Compliance integration entries.
 * @returns The provider's detail, or `null` when no family lists it.
 */
export function resolveIntegrationDetail(input: {
  provider: string;
  custody: CustodyProviderAvailability[];
  ramps: IntegrationEntry<RampProviderId>[];
  compliance: IntegrationEntry<ComplianceProviderId>[];
}): IntegrationDetail | null {
  const custodyMatch = input.custody.find((entry) => entry.entry.id === input.provider);
  if (custodyMatch) {
    return {
      family: "custody",
      provider: custodyMatch.entry.id,
      label: custodyMatch.entry.label,
      status: custodyMatch.status,
      descriptionKey: custodyMatch.entry.descriptionKey,
      custodyEntry: custodyMatch.entry,
    };
  }

  for (const [family, entries] of [
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
