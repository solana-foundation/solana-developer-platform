"use client";

import { Button } from "@sdp/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sdp/ui/card";
import Link from "next/link";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { ApiKeyFlashSurface } from "./api-key-flash-surface";
import { ApiKeysListSkeleton } from "./api-key-page-skeletons";
import { useApiKeys } from "./api-keys.data";
import { type ApiKeyRecord, ApiKeysTableClient } from "./api-keys-table-client";

export function ApiKeysWorkspace() {
  const t = useTranslations();
  const href = useProjectHref();
  const { dashboardAccess } = useDashboardWorkspace();
  const { canManageApiKeys } = dashboardAccess.capabilities;
  const apiKeys = useApiKeys();

  if (!apiKeys.data && !apiKeys.error) {
    return <ApiKeysListSkeleton />;
  }

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-6">
      <ApiKeyFlashSurface />

      <Card className="flex-1">
        <CardHeader>
          <CardTitle>{t("DashboardCustody.existingApiKeys")}</CardTitle>
          <CardDescription>{t("DashboardCustody.existingApiKeysDescription")}</CardDescription>
          {canManageApiKeys && apiKeys.data && apiKeys.data.length > 0 ? (
            <CardAction>
              <Button asChild>
                <Link href={href("/dashboard/api-keys/new")}>
                  {t("DashboardCustody.newApiKey")}
                </Link>
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col">
          {!canManageApiKeys ? (
            <div className="mb-4 rounded-[10px] border border-border-default bg-fill-subtle px-3 py-2 text-xs text-secondary">
              {t("DashboardCustody.apiKeysViewOnly")}
            </div>
          ) : null}
          <div className="mb-4 rounded-[10px] border border-border-default bg-fill-subtle px-3 py-2 text-xs text-secondary">
            <p className="text-xs text-secondary">{t("DashboardCustody.apiKeyRotationHint")}</p>
          </div>
          <div className="@container/api-keys-table flex flex-1 flex-col">
            {apiKeys.data ? (
              canManageApiKeys ? (
                <ApiKeysTableWithWalletLabels apiKeys={apiKeys.data} />
              ) : (
                <ApiKeysTableClient
                  initialApiKeys={apiKeys.data}
                  canManageApiKeys={false}
                  wallets={[]}
                />
              )
            ) : (
              <div role="alert" className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-destructive-strong">{t("Shared.apiKeys.loadFailed")}</p>
                <Button type="button" size="sm" onClick={() => void apiKeys.mutate()}>
                  {t("Shared.apiKeys.retry")}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </DashboardWorkspaceOverviewPanel>
  );
}

// Wallets only name the wallets a selected key lists, and only key managers read them: until
// they load, or if they fail, a row shows the wallet ids it holds.
function ApiKeysTableWithWalletLabels({ apiKeys }: { apiKeys: ApiKeyRecord[] }) {
  const wallets = useWalletSummaries({ includeBalances: false });
  return (
    <ApiKeysTableClient initialApiKeys={apiKeys} canManageApiKeys wallets={wallets.data ?? []} />
  );
}
