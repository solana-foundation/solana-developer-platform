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
  const [t, { userId, orgId, orgRole }, { approvalRequestId }] = await Promise.all([
    getTranslations(),
    auth(),
    params,
  ]);
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

  const apiClient = await createSdpApiClient();
  const apiKeyNamesPromise = fetchApprovalApiKeyNames(apiClient);
  // The primary request can exit through notFound() before this speculative
  // lookup is awaited. Keep that early exit from leaving a rejected promise
  // unobserved if the helper ever stops being fail-soft.
  void apiKeyNamesPromise.catch(() => undefined);
  let approvalRequest: WalletApprovalRequestSummary;
  try {
    approvalRequest = await fetchApprovalRequest(apiClient, approvalRequestId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) notFound();
    throw error;
  }

  const [evaluation, apiKeyNames] = await Promise.all([
    fetchApprovalPolicyEvaluation(apiClient, approvalRequest),
    apiKeyNamesPromise,
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
