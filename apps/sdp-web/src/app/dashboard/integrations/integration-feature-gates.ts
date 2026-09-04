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
 * dashboard module. RPC remains generally available because it is platform
 * infrastructure rather than a gated product workspace.
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
    case "rpc":
      return true;
  }
}

/** Keeps provider deep links aligned with the families shown in the catalog. */
export function isIntegrationProviderEnabled(
  provider: string,
  flags: Pick<IntegrationFeatureFlags, "custody" | "payments" | "policies">
): boolean {
  if (isKnownCustodyProvider(provider)) return flags.custody;
  if ((RAMP_PROVIDERS as readonly string[]).includes(provider)) return flags.payments;
  if ((COMPLIANCE_PROVIDERS as readonly string[]).includes(provider)) return flags.policies;
  return true;
}
