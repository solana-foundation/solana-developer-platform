import { redirect } from "next/navigation";
import { resolveOrganizationId } from "@/app/(session)/dashboard/[projectId]/settings/organization-id";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createOrgSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { FeedbackForm } from "./feedback-form";

export default async function FeedbackPage() {
  // Sending is `feedback.execute`: admins and members hold it, viewers do not.
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canSendFeedback) {
    redirect(await requestProjectHref("/dashboard"));
  }
  const organizationId = await resolveOrganizationId(await createOrgSdpApiClient());
  return <FeedbackForm organizationId={organizationId} />;
}
