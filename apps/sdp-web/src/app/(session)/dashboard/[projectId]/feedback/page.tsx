import { redirect } from "next/navigation";
import { resolveOrganizationId } from "@/app/(session)/dashboard/[projectId]/settings/organization-id";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { DASHBOARD_FEEDBACK_FROM_PARAM } from "@/lib/dashboard-navigation-loading";
import { createOrgSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { feedbackFromPath } from "./feedback-files";
import { FeedbackForm } from "./feedback-form";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Sending is `feedback.execute`: admins and members hold it, viewers do not.
  if (!resolveDashboardAccess(await requestMemberRole()).capabilities.canSendFeedback) {
    redirect(await requestProjectHref("/dashboard"));
  }
  const fromPath = feedbackFromPath((await searchParams)[DASHBOARD_FEEDBACK_FROM_PARAM]);
  const organizationId = await resolveOrganizationId(await createOrgSdpApiClient());
  return <FeedbackForm organizationId={organizationId} fromPath={fromPath} />;
}
