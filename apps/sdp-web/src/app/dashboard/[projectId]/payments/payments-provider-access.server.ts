import { z } from "zod";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

// The one field provider access reads: SDP's own id for the organization.
const onboardingOrganizationSchema = z.object({
  organization: z.object({ id: z.string() }).nullable(),
});

/**
 * The organization's provider access, read under SDP's own organization id:
 * Clerk's org id names a different record, and the API refuses it. Null when
 * the onboarding status or the access read fails, or names no organization.
 */
export async function loadOrganizationProviderAccess(): Promise<Awaited<
  ReturnType<typeof fetchProviderAvailability>
> | null> {
  const orgClient = await createOrgSdpApiClient();
  let organizationId: string;
  try {
    const status = onboardingOrganizationSchema.parse(
      await orgClient.fetch<unknown>("/v1/onboarding/status")
    );
    if (status.organization === null) return null;
    organizationId = status.organization.id;
  } catch {
    return null;
  }
  return fetchProviderAvailability(orgClient.request, organizationId).catch(() => null);
}
