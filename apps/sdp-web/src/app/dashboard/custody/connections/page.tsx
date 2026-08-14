import { auth } from "@clerk/nextjs/server";
import type { CustodyWalletSummary } from "@sdp/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  fetchConnectionsPage,
  fetchWalletsByConnection,
  parseConnectionsFilters,
} from "./connections.data";
import { ConnectionsList } from "./connections-list";

export const dynamic = "force-dynamic";

export default async function CustodyConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const [resolvedSearchParams, t] = await Promise.all([searchParams, getTranslations()]);
  const filters = parseConnectionsFilters(resolvedSearchParams);
  const canManageCustody = resolveDashboardAccess(orgRole).capabilities.canManageCustody;

  try {
    const apiClient = await createSdpApiClient();
    // Wallet rows are context, not the record of truth here: if the wallet read
    // fails the list still renders and only the wallet column degrades.
    const [result, walletsResult] = await Promise.all([
      fetchConnectionsPage(apiClient.request, filters),
      fetchWalletsByConnection(apiClient.request).then(
        (byConnection) => ({ ok: true as const, byConnection }),
        () => ({ ok: false as const, byConnection: new Map<string, CustodyWalletSummary[]>() })
      ),
    ]);

    return (
      <DashboardWorkspaceOverviewPanel className="flex flex-col">
        <DashboardWorkspaceCard>
          <ConnectionsList
            result={result}
            filters={filters}
            walletsByConnection={Object.fromEntries(walletsResult.byConnection)}
            walletsUnavailable={!walletsResult.ok}
            canManageCustody={canManageCustody}
          />
        </DashboardWorkspaceCard>
      </DashboardWorkspaceOverviewPanel>
    );
  } catch {
    return (
      <DashboardWorkspaceOverviewPanel>
        <ListEmptyState
          message={t("DashboardCustody.connectionsLoadError")}
          description={t("DashboardCustody.connectionsLoadErrorDescription")}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link href="/dashboard/wallets">{t("Shared.dashboardShell.backToWallets")}</Link>
            </Button>
          }
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }
}
