"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { useAssetProfileForm } from "../asset-profile/use-asset-profile-form";
import { useTokenOperations } from "../asset-profile/use-token-operations";
import { TokenActivityTab } from "./activity-tab";
import { TokenComplianceTab } from "./compliance-tab";
import { TokenDetailsTab } from "./details-tab";
import { TokenOperationsTab } from "./operations-tab";
import { TokenOverviewTab } from "./overview-tab";
import { TokenPermissionsTab } from "./permissions-tab";
import { TokenPublicTab } from "./public-tab";
import { TokenDialogs } from "./token-dialogs";
import {
  type LatestDeployAttempt,
  resolveTokenTab,
  type TokenTab,
  tokenPageLifecycle,
} from "./token-page.shared";

/**
 * One token's page as the design lays it out: its name in the header over Overview, Details,
 * Public information, Compliance, Operations, Permissions and Activity (`?tab=`). Every
 * operation runs through the same hooks and dialogs as the previous design's page.
 */
export function TokenPageView({
  token,
  assetProfile,
  latestDeploy,
}: {
  token: Token;
  assetProfile: AssetProfile;
  latestDeploy: LatestDeployAttempt | null;
}) {
  const { dashboardAccess } = useDashboardWorkspace();
  const canManageTokenAdmin = dashboardAccess.capabilities.canManageTokenAdmin;
  const tab = resolveTokenTab(useDashboardTab());
  const { replaceSearchParams } = useDashboardUrlState();
  const openTab = useCallback(
    (next: TokenTab) => replaceSearchParams({ tab: next === "overview" ? null : next }),
    [replaceSearchParams]
  );

  const ops = useTokenOperations({
    token,
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin,
  });
  const form = useAssetProfileForm({
    token,
    assetProfile,
    metadataSignerSelection: ops.metadataSignerSelection,
    draftWallets: ops.authorityWalletsError ? [] : ops.authorityWallets,
  });
  const state = tokenPageLifecycle(token, latestDeploy);
  const page = { token, assetProfile: form.assetProfile, ops, form, state, canManageTokenAdmin };
  const explorer = useExplorerAction(ops.explorerHref);

  return (
    <DashboardWorkspaceOverviewPanel data-token-page={tab}>
      <DashboardPageTitle title={token.name} actions={explorer} />
      {tab === "overview" ? (
        <TokenOverviewTab {...page} latestDeploy={latestDeploy} onOpenTab={openTab} />
      ) : null}
      {tab === "details" ? <TokenDetailsTab {...page} /> : null}
      {tab === "public" ? <TokenPublicTab {...page} /> : null}
      {tab === "compliance" ? <TokenComplianceTab {...page} /> : null}
      {tab === "operations" ? <TokenOperationsTab {...page} onOpenTab={openTab} /> : null}
      {tab === "permissions" ? <TokenPermissionsTab {...page} /> : null}
      {tab === "activity" ? <TokenActivityTab token={token} /> : null}
      <TokenDialogs ops={ops} token={token} />
    </DashboardWorkspaceOverviewPanel>
  );
}

/** The mint on the explorer, at the header's end on every tab once the token is on chain. */
function useExplorerAction(href: string | null | undefined) {
  const t = useTranslations();
  const label = t("DashboardIssuance.newDesign.overview.explorer");
  // A stable element, so the shell's header is set once per token rather than every render.
  return useMemo(
    () =>
      href ? (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-secondary hover:text-primary"
          iconRight={<ArrowUpRightIcon aria-hidden="true" />}
        >
          <a href={href} target="_blank" rel="noreferrer" data-token-explorer>
            {label}
          </a>
        </Button>
      ) : undefined,
    [href, label]
  );
}
