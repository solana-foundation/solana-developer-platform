import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createOrgSdpApiClient, requestOnboardingStatus } from "@/lib/sdp-api";
import type { EarnProviderAccess } from "./earn-surfacing";

/**
 * Resolve the signed-in organization's real Earn entitlement/configuration.
 *
 * A catalogue row only says a strategy exists. It does not authorize this
 * organization to fund it, so every deposit-facing page consumes this result
 * and fails closed when access cannot be verified. The onboarding status is
 * the request's shared read, so the layout's quick start does not repeat it.
 */
export async function loadEarnProviderAccess(): Promise<EarnProviderAccess | null> {
  try {
    const onboarding = await requestOnboardingStatus();
    if (!onboarding.linked || !onboarding.organization) return null;

    const client = await createOrgSdpApiClient();
    const availability = await fetchProviderAvailability(
      client.request,
      onboarding.organization.id
    );
    return availability.providers.earn;
  } catch (error) {
    console.error("Failed to load Earn provider access; deposit actions remain disabled", error);
    return null;
  }
}
