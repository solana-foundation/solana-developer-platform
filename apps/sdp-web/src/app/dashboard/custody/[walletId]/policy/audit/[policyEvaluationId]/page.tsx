import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchPolicyAuditContext,
  fetchPolicyEvaluation,
  fetchPolicyEvaluationNeighbors,
  firstSearchParam,
  PolicyAuditRequestError,
  parsePolicyAuditFilters,
} from "../../policy-audit.data";
import { PolicyAuditLoadError } from "../../policy-audit.shared";
import { PolicyAuditDetail, type PolicyAuditDetailTab } from "../../policy-audit-detail";

export const dynamic = "force-dynamic";

export default async function WalletPolicyAuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ walletId: string; policyEvaluationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const [resolvedParams, resolvedSearchParams, locale, t] = await Promise.all([
    params,
    searchParams,
    getRequestLocale(),
    getTranslations(),
  ]);
  const walletId = decodeURIComponent(resolvedParams.walletId);
  const policyEvaluationId = decodeURIComponent(resolvedParams.policyEvaluationId);
  const policyHref = `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`;
  const filters = parsePolicyAuditFilters(resolvedSearchParams);
  const tab = parseDetailTab(resolvedSearchParams.tab);
  const selectedRevisionId = firstSearchParam(resolvedSearchParams.revision);

  try {
    const apiClient = await createSdpApiClient();
    const [context, evaluation, neighbors] = await Promise.all([
      fetchPolicyAuditContext(apiClient.request, walletId),
      fetchPolicyEvaluation(apiClient.request, walletId, policyEvaluationId),
      fetchPolicyEvaluationNeighbors(apiClient.request, walletId, policyEvaluationId, filters),
    ]);

    return (
      <DashboardWorkspaceOverviewPanel>
        <PolicyAuditDetail
          wallet={context.wallet}
          evaluation={evaluation}
          revisionHistory={context.revisionHistory}
          apiKeyNames={context.apiKeyNames}
          neighbors={neighbors}
          filters={filters}
          tab={tab}
          selectedRevisionId={selectedRevisionId}
          locale={locale}
          t={t}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  } catch (error) {
    if (error instanceof PolicyAuditRequestError && error.status === 404) notFound();
    return (
      <DashboardWorkspaceOverviewPanel>
        <PolicyAuditLoadError backHref={policyHref} t={t} />
      </DashboardWorkspaceOverviewPanel>
    );
  }
}

function parseDetailTab(value: string | string[] | undefined): PolicyAuditDetailTab {
  const tab = firstSearchParam(value);
  return tab === "request" || tab === "revisions" ? tab : "decision";
}
