import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { projectHref } from "@/lib/dashboard-project-path";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import {
  fetchPolicyAuditContext,
  fetchPolicyEvaluation,
  fetchPolicyEvaluationNeighbors,
  PolicyAuditRequestError,
  parsePolicyAuditFilters,
} from "../../policy-audit.data";
import { PolicyAuditLoadError } from "../../policy-audit.shared";
import { PolicyAuditDetail } from "../../policy-audit-detail";

export const dynamic = "force-dynamic";

export default async function WalletPolicyAuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; walletId: string; policyEvaluationId: string }>;
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
  const policyHref = projectHref(
    resolvedParams.projectId,
    `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`
  );
  const filters = parsePolicyAuditFilters(resolvedSearchParams);

  try {
    const apiClient = await createProjectBoundSdpApiClient(resolvedParams.projectId);
    const [context, evaluation, neighbors] = await Promise.all([
      fetchPolicyAuditContext(apiClient.request, walletId),
      fetchPolicyEvaluation(apiClient.request, walletId, policyEvaluationId),
      fetchPolicyEvaluationNeighbors(apiClient.request, walletId, policyEvaluationId, filters),
    ]);

    return (
      <DashboardWorkspaceOverviewPanel>
        <PolicyAuditDetail
          projectId={resolvedParams.projectId}
          wallet={context.wallet}
          evaluation={evaluation}
          revisionHistory={context.revisionHistory}
          apiKeyNames={context.apiKeyNames}
          userNames={context.userNames}
          neighbors={neighbors}
          filters={filters}
          locale={locale}
          t={t}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  } catch (error) {
    if (error instanceof PolicyAuditRequestError && error.status === 404) notFound();
    return (
      <DashboardWorkspaceOverviewPanel>
        <PolicyAuditLoadError
          backHref={`${policyHref}/audit`}
          backLabel={t("DashboardCustody.policyAuditBackToAudit")}
          t={t}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }
}
