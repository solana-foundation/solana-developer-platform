import { z } from "zod";
import type { createOrgSdpApiClient } from "@/lib/sdp-api";

const onboardingOrganizationSchema = z.object({
  linked: z.boolean(),
  organization: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
});

/** The signed-in organization's SDP id from the onboarding status; null while it is not linked. */
export async function resolveOrganizationId(
  client: Awaited<ReturnType<typeof createOrgSdpApiClient>>
): Promise<string | null> {
  const onboarding = onboardingOrganizationSchema.parse(
    await client.fetch<unknown>("/v1/onboarding/status")
  );
  return onboarding.linked && onboarding.organization ? onboarding.organization.id : null;
}
