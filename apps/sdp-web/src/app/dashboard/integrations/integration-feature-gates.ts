import { COMPLIANCE_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import { isKnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import type { IntegrationFamily } from "./integrations-filter";

export type IntegrationFeatureFlags = {
  custody: boolean;
  payments: boolean;
  policies: boolean;
  privateChannels: boolean;
};

/**
 * Product-owned integration families follow the same release switch as their
 * dashboard module.
 *
 * @param family - The integration family to check.
 * @param flags - The resolved dashboard feature flags.
 * @returns Whether the family is shown in the catalog.
 */
export function isIntegrationFamilyEnabled(
  family: IntegrationFamily,
  flags: IntegrationFeatureFlags
): boolean {
  switch (family) {
    case "custody":
      return flags.custody;
    case "ramps":
      return flags.payments;
    case "compliance":
      return flags.policies;
    case "privacy":
      return flags.privateChannels;
  }
}

/**
 * Keeps provider deep links aligned with the families shown in the catalog.
 *
 * @param provider - A provider id that `isKnownIntegrationProvider` accepted.
 * @param flags - The resolved dashboard feature flags.
 * @returns Whether the provider's family is enabled; false for an id outside every family.
 */
export function isIntegrationProviderEnabled(
  provider: string,
  flags: Pick<IntegrationFeatureFlags, "custody" | "payments" | "policies">
): boolean {
  if (isKnownCustodyProvider(provider)) return flags.custody;
  if ((RAMP_PROVIDERS as readonly string[]).includes(provider)) return flags.payments;
  if ((COMPLIANCE_PROVIDERS as readonly string[]).includes(provider)) return flags.policies;
  return false;
}
