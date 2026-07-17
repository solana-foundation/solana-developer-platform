import { auth } from "@clerk/nextjs/server";
import type { WalletApprovalRequestSummary } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchApprovalApiKeyNames,
  fetchApprovalPolicyEvaluation,
  fetchApprovalRequest,
} from "../approval-requests.server";
import { ApprovalRequestDetail } from "./approval-request-detail";

export const dynamic = "force-dynamic";

type PageContext = {
  params: Promise<{ approvalRequestId: string }>;
};

export default async function ApprovalRequestPage({ params }: PageContext) {
  const t = await getTranslations();
  const { userId, orgId, orgRole } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const dashboardAccess = resolveDashboardAccess(orgRole);
  if (!dashboardAccess.capabilities.canReadApprovals) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-medium text-primary">{t("DashboardApprovals.noAccess")}</h1>
          <p className="mt-2 text-sm text-secondary">
            {t("DashboardApprovals.noAccessDescription")}
          </p>
        </div>
      </div>
    );
  }

  const { approvalRequestId } = await params;
  const apiClient = await createSdpApiClient();
  let approvalRequest: WalletApprovalRequestSummary;
  try {
    approvalRequest = await fetchApprovalRequest(apiClient, approvalRequestId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) notFound();
    throw error;
  }

  const [evaluation, apiKeyNames] = await Promise.all([
    fetchApprovalPolicyEvaluation(apiClient, approvalRequest),
    fetchApprovalApiKeyNames(apiClient),
  ]);

  return (
    <ApprovalRequestDetail
      initialRequest={approvalRequest}
      evaluation={evaluation}
      apiKeyNames={apiKeyNames}
      canDecide={dashboardAccess.capabilities.canDecideApprovals}
    />
  );
}
