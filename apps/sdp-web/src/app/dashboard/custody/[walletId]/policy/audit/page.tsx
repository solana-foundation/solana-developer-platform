import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchPolicyAuditContext,
  fetchPolicyAuditList,
  PolicyAuditRequestError,
  parsePolicyAuditFilters,
} from "../policy-audit.data";
import { PolicyAuditLoadError } from "../policy-audit.shared";
import { PolicyAuditList } from "../policy-audit-list";

export const dynamic = "force-dynamic";

export default async function WalletPolicyAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ walletId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const [{ walletId }, resolvedSearchParams, locale, t] = await Promise.all([
    params,
    searchParams,
    getRequestLocale(),
    getTranslations(),
  ]);
  const resolvedWalletId = decodeURIComponent(walletId);
  const policyHref = `/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}/policy`;
  const filters = parsePolicyAuditFilters(resolvedSearchParams);

  try {
    const apiClient = await createSdpApiClient();
    const [context, result] = await Promise.all([
      fetchPolicyAuditContext(apiClient.request, resolvedWalletId),
      fetchPolicyAuditList(apiClient.request, resolvedWalletId, filters),
    ]);

    return (
      <DashboardWorkspaceOverviewPanel>
        <PolicyAuditList
          walletId={resolvedWalletId}
          walletLabel={context.wallet.label?.trim() || context.wallet.walletId}
          result={result}
          filters={filters}
          revisionHistory={context.revisionHistory}
          apiKeyNames={context.apiKeyNames}
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
