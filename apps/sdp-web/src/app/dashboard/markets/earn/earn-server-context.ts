import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import type { SdpApiClient } from "@/lib/sdp-api";

/**
 * Resolve Clerk's active organization to the SDP organization row used by
 * organization-scoped API routes.
 *
 * The two identifiers are deliberately not interchangeable. Clerk's `orgId`
 * authenticates the session; `/v1/onboarding/status` returns the linked SDP id
 * that `/v1/organizations/:orgId/provider-access` authorizes and queries.
 */
export async function fetchEarnSdpOrganizationId(
  organizationClient: Pick<SdpApiClient, "fetch">
): Promise<string | null> {
  const onboarding =
    await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
  return onboarding.organization?.id ?? null;
}
