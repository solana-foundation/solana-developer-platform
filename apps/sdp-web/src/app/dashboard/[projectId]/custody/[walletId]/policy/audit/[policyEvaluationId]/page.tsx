import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
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
  const policyHref = await requestProjectHref(
    `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`
  );
  const filters = parsePolicyAuditFilters(resolvedSearchParams);

  let canonicalHref = "";
  try {
    const apiClient = await createSdpApiClient();
    const context = await fetchPolicyAuditContext(apiClient.request, walletId);
    if (context.wallet.id !== walletId) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(resolvedSearchParams)) {
        for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          query.append(key, entry);
        }
      }
      canonicalHref = await requestProjectHref(
        `/dashboard/wallets/${encodeURIComponent(context.wallet.id)}/policy/audit/${encodeURIComponent(policyEvaluationId)}${query.size ? `?${query}` : ""}`
      );
    } else {
      const [evaluation, neighbors] = await Promise.all([
        fetchPolicyEvaluation(apiClient.request, context.wallet.id, policyEvaluationId),
        fetchPolicyEvaluationNeighbors(
          apiClient.request,
          context.wallet.id,
          policyEvaluationId,
          filters
        ),
      ]);

      return (
        <DashboardWorkspaceOverviewPanel>
          <PolicyAuditDetail
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
    }
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
  redirect(canonicalHref);
}
