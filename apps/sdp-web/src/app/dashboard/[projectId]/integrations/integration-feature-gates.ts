import { COMPLIANCE_PROVIDERS, type RampProviderId } from "@sdp/types";
import { isKnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import type { IntegrationFamily } from "./integrations-filter";

export type IntegrationFeatureFlags = {
  custody: boolean;
  /**
   * The ramp providers offered (`getOfferedRampProviders`): each capped at its own release stage,
   * none while Payments is off.
   */
  rampProviders: readonly RampProviderId[];
  /** The `policies` flag, until Compliance gets its own visibility rule. */
  compliance: boolean;
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
      return flags.rampProviders.length > 0;
    case "compliance":
      return flags.compliance;
    case "privacy":
      return flags.privateChannels;
  }
}

/**
 * Keeps provider deep links aligned with the families shown in the catalog.
 *
 * @param provider - A provider id that `isKnownIntegrationProvider` accepted.
 * @param flags - The resolved dashboard feature flags.
 * @returns Whether the provider's family is enabled, and for a ramp whether that provider is
 *   offered; false for an id outside every family.
 */
export function isIntegrationProviderEnabled(
  provider: string,
  flags: Pick<IntegrationFeatureFlags, "compliance" | "custody" | "rampProviders">
): boolean {
  if (isKnownCustodyProvider(provider)) return flags.custody;
  if (flags.rampProviders.some((offered) => offered === provider)) return true;
  if ((COMPLIANCE_PROVIDERS as readonly string[]).includes(provider)) return flags.compliance;
  return false;
}
