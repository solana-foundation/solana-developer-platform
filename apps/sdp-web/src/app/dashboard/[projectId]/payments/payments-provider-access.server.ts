import type { OnboardingStatusResponse } from "@/app/dashboard/[projectId]/onboarding-status";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

/**
 * The organization's provider access, read under SDP's own organization id:
 * Clerk's org id names a different record, and the API refuses it.
 */
export async function loadOrganizationProviderAccess(): Promise<Awaited<
  ReturnType<typeof fetchProviderAvailability>
> | null> {
  const orgClient = await createOrgSdpApiClient();
  const status = await orgClient
    .fetch<OnboardingStatusResponse>("/v1/onboarding/status")
    .catch(() => null);
  if (!status?.organization) return null;
  return fetchProviderAvailability(orgClient.request, status.organization.id).catch(() => null);
}
