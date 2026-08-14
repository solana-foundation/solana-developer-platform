import { auth } from "@clerk/nextjs/server";
import type { WalletApprovalRequestSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchPaymentsIssuedTokenSymbols,
  type PaymentsIssuedTokenSymbol,
} from "../payments/payments-page.data";
import { ApprovalInbox } from "./approval-inbox";
import { fetchApprovalApiKeyNames, fetchApprovalRequests } from "./approval-requests.server";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const [t, { userId, orgId, orgRole }] = await Promise.all([getTranslations(), auth()]);
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

  let requests: WalletApprovalRequestSummary[] = [];
  let apiKeyNames: Record<string, string> = {};
  let issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol> = {};
  let loadError = false;

  try {
    const apiClient = await createSdpApiClient();
    // Issued tokens are absent from the well-known catalogue, so without this
    // map every token this org minted renders as a shortened mint address.
    const [fetchedRequests, fetchedApiKeyNames, issuedTokenSymbolsResult] = await Promise.all([
      fetchApprovalRequests(apiClient),
      fetchApprovalApiKeyNames(apiClient),
      fetchPaymentsIssuedTokenSymbols(apiClient.request),
    ]);
    requests = fetchedRequests;
    apiKeyNames = fetchedApiKeyNames;
    issuedTokensByMint = Object.fromEntries(
      (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token])
    );
  } catch {
    loadError = true;
  }

  return (
    <ApprovalInbox
      initialRequests={requests}
      apiKeyNames={apiKeyNames}
      issuedTokensByMint={issuedTokensByMint}
      canDecide={dashboardAccess.capabilities.canDecideApprovals}
      renderedAt={Date.now()}
      loadError={loadError}
    />
  );
}
