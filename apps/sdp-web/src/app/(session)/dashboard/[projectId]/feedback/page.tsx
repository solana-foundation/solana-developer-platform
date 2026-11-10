import { resolveOrganizationId } from "@/app/(session)/dashboard/[projectId]/settings/organization-id";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { FeedbackForm } from "./feedback-form";

export default async function FeedbackPage() {
  const organizationId = await resolveOrganizationId(await createOrgSdpApiClient());
  return <FeedbackForm organizationId={organizationId} />;
}
