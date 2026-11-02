import { z } from "zod";
import type { createOrgSdpApiClient } from "@/lib/sdp-api";

const onboardingOrganizationSchema = z.object({
  linked: z.boolean(),
  organization: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
});

/** The signed-in organization's SDP id, from the onboarding status. */
export async function resolveOrganizationId(
  client: Awaited<ReturnType<typeof createOrgSdpApiClient>>
): Promise<string> {
  const onboarding = onboardingOrganizationSchema.parse(
    await client.fetch<unknown>("/v1/onboarding/status")
  );
  if (!onboarding.linked || !onboarding.organization) {
    throw new Error("Organization is not linked yet");
  }
  return onboarding.organization.id;
}
