import { auth } from "@clerk/nextjs/server";
import type { WalletApprovalRequestSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { ApprovalInbox } from "./approval-inbox";
import type { ApprovalInboxTab } from "./approval-requests.data";
import { fetchApprovalApiKeyNames, fetchApprovalRequests } from "./approval-requests.server";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, { userId, orgId, orgRole }, resolvedSearchParams] = await Promise.all([
    getTranslations(),
    auth(),
    searchParams,
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

  const rawTab = resolvedSearchParams.tab;
  const tabValue = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  const initialTab: ApprovalInboxTab = tabValue === "history" ? "history" : "pending";
  let requests: WalletApprovalRequestSummary[] = [];
  let apiKeyNames: Record<string, string> = {};
  let loadError = false;

  try {
    const apiClient = await createSdpApiClient();
    [requests, apiKeyNames] = await Promise.all([
      fetchApprovalRequests(apiClient),
      fetchApprovalApiKeyNames(apiClient),
    ]);
  } catch {
    loadError = true;
  }

  return (
    <ApprovalInbox
      initialRequests={requests}
      apiKeyNames={apiKeyNames}
      canDecide={dashboardAccess.capabilities.canDecideApprovals}
      initialTab={initialTab}
      renderedAt={Date.now()}
      loadError={loadError}
    />
  );
}
