import { auth } from "@clerk/nextjs/server";
import { History } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchPolicyRevisionContext,
  firstSearchParam,
  PolicyAuditRequestError,
} from "../policy-audit.data";
import { PolicyAuditLoadError } from "../policy-audit.shared";
import { PolicyRevisionExplorer } from "../policy-revision-explorer";

export const dynamic = "force-dynamic";

export default async function WalletPolicyRevisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ walletId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const [{ walletId: encodedWalletId }, resolvedSearchParams, locale, t] = await Promise.all([
    params,
    searchParams,
    getRequestLocale(),
    getTranslations(),
  ]);
  const walletId = decodeURIComponent(encodedWalletId);
  const policyHref = `/dashboard/wallets/${encodeURIComponent(walletId)}/policy`;
  const revisionsHref = `${policyHref}/revisions`;
  const auditHref = `${policyHref}/audit`;
  const selectedRevisionId = firstSearchParam(resolvedSearchParams.revision);

  try {
    const apiClient = await createSdpApiClient();
    const context = await fetchPolicyRevisionContext(apiClient.request, walletId);
    return (
      <DashboardWorkspaceOverviewPanel>
        <div className="mx-auto w-full max-w-[1500px] space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-medium text-primary sm:text-3xl">
                {t("DashboardCustody.policyRevisionsWalletHistory", {
                  wallet: context.wallet.label?.trim() || context.wallet.walletId,
                })}
              </h1>
              <p className="mt-1 text-sm text-secondary">
                {t("DashboardCustody.policyRevisionsDescription")}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href={auditHref}>
                <History className="size-4" />
                {t("DashboardCustody.policyAuditTitle")}
              </Link>
            </Button>
          </div>
          <PolicyRevisionExplorer
            history={context.revisionHistory}
            selectedRevisionId={selectedRevisionId}
            baseHref={revisionsHref}
            locale={locale}
            t={t}
          />
        </div>
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
