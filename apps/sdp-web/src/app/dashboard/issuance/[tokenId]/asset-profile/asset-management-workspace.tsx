"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { Loader2, Play } from "lucide-react";
import { motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { togglePublicField } from "../../create/draft-mapping";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import type { FundManagementModalAction } from "../token-fund-management-section";
import { TokenManagementModalShell } from "../token-management-modal-shell";
import { TokenSignerSelect } from "../token-signer-select";
import { AssetProfileHeader } from "./asset-profile-header";
import { AssetProfileSaveBar } from "./asset-profile-save-bar";
import { ComplianceTab } from "./tabs/compliance-tab";
import { DetailsTab } from "./tabs/details-tab";
import { OperationsTab } from "./tabs/operations-tab";
import { OpsActionForms } from "./tabs/ops-action-forms";
import { OverviewTab } from "./tabs/overview-tab";
import { PermissionsTab } from "./tabs/permissions-tab";
import { PublicInfoTab } from "./tabs/public-info-tab";
import { useAssetProfileForm } from "./use-asset-profile-form";
import { useTokenOperations } from "./use-token-operations";

type AssetManagementTab =
  | "overview"
  | "details"
  | "public-info"
  | "compliance"
  | "operations"
  | "permissions";

const managementTabIds: AssetManagementTab[] = ["overview", "details", "public-info", "compliance", "operations", "permissions"];

// Deep links minted for the legacy workspace keep working.
const LEGACY_TAB_MAP: Record<string, AssetManagementTab> = {
  "fund-management": "operations",
  metadata: "details",
  extensions: "permissions",
};

function resolveTab(value: string | null): AssetManagementTab {
  if (value && managementTabIds.includes(value as AssetManagementTab)) {
    return value as AssetManagementTab;
  }
  if (value && LEGACY_TAB_MAP[value]) {
    return LEGACY_TAB_MAP[value];
  }
  return "overview";
}

export function shouldOpenPendingFundManagementModal({
  activeTab,
  pendingFundManagementModalAction,
}: {
  activeTab: AssetManagementTab;
  pendingFundManagementModalAction: FundManagementModalAction | null;
}) {
  return Boolean(pendingFundManagementModalAction && activeTab === "operations");
}

export function AssetManagementWorkspace({
  token,
  assetProfile,
  tokenError,
}: {
  token: Token;
  assetProfile: AssetProfile;
  tokenError: string | null;
}) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const canManageTokenAdmin = dashboardAccess.capabilities.canManageTokenAdmin;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const requestedTabParam = searchParams.get("tab");
  const activeTab = resolveTab(requestedTabParam);
  const [pendingFundManagementModalAction, setPendingFundManagementModalAction] = useState<
    "deploy" | "mint" | "burn" | null
  >(null);

  const ops = useTokenOperations({
    token,
    shouldLoadSupportingData: activeTab !== "overview",
    shouldLoadAuthorityWallets: activeTab !== "overview" || token.status === "pending",
    canManageTokenAdmin,
  });
  const form = useAssetProfileForm({ token, assetProfile });
  const managementTabs: Array<{ id: AssetManagementTab; label: string }> = [
    { id: "overview", label: t("DashboardIssuance.tabs.overview") },
    { id: "details", label: t("DashboardIssuance.tabs.details") },
    { id: "public-info", label: t("DashboardIssuance.tabs.publicInformation") },
    { id: "compliance", label: t("DashboardIssuance.tabs.compliance") },
    { id: "operations", label: t("DashboardIssuance.tabs.operations") },
    { id: "permissions", label: t("DashboardIssuance.tabs.permissions") },
  ];

  const syncActiveTabInUrl = useCallback(
    (nextTab: AssetManagementTab, mode: "push" | "replace" = "push") => {
      const nextSearchParams = new URLSearchParams(searchParams.toString());
      if (nextTab === "overview") {
        nextSearchParams.delete("tab");
      } else {
        nextSearchParams.set("tab", nextTab);
      }

      const nextQuery = nextSearchParams.toString();
      const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      if (mode === "replace") {
        router.replace(nextUrl, { scroll: false });
        return;
      }

      router.push(nextUrl, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  // Deploy from anywhere in the workspace: jump to Operations and open the
  // deploy modal (shared by the header CTA and the overview readiness card).
  const handleDeploy = useCallback(() => {
    if (!ops.canDeployToken) {
      return;
    }

    if (activeTab === "operations") {
      ops.openFundManagementModal("deploy");
      return;
    }

    setPendingFundManagementModalAction("deploy");
    syncActiveTabInUrl("operations");
  }, [activeTab, ops.canDeployToken, ops.openFundManagementModal, syncActiveTabInUrl]);

  // Normalize legacy/unknown tab params in the URL.
  useEffect(() => {
    if (!requestedTabParam) {
      return;
    }
    if (requestedTabParam !== activeTab || activeTab === "overview") {
      syncActiveTabInUrl(activeTab, "replace");
    }
  }, [activeTab, requestedTabParam, syncActiveTabInUrl]);

  // The deploy/mint/burn modal belongs to the Operations tab.
  useEffect(() => {
    if (activeTab !== "operations" && ops.fundManagementModalAction) {
      ops.closeFundManagementModal();
    }
  }, [activeTab, ops.fundManagementModalAction, ops.closeFundManagementModal]);

  useEffect(() => {
    if (
      !shouldOpenPendingFundManagementModal({
        activeTab,
        pendingFundManagementModalAction,
      }) ||
      !pendingFundManagementModalAction
    ) {
      return;
    }

    ops.openFundManagementModal(pendingFundManagementModalAction);
    setPendingFundManagementModalAction(null);
  }, [activeTab, ops.openFundManagementModal, pendingFundManagementModalAction]);

  const effectivePauseDisabledReason = ops.effectivePauseDisabledReason;

  return (
    <div className="space-y-4 pb-8">
      <AssetProfileHeader
        token={token}
        assetProfile={form.assetProfile}
        explorerHref={ops.explorerHref}
        canDeployToken={ops.canDeployToken}
        isPending={ops.isPending}
        deployDisabledReason={ops.deploySignerSelection.unavailableReason}
        pauseDisabledReason={ops.pauseDisabledReason}
        canManageTokenAdmin={canManageTokenAdmin}
        onCopyAddress={() => void ops.handleCopy(token.mintAddress)}
        onCopyTokenId={() => void ops.handleCopy(token.id, "Token ID copied")}
        onDeploy={handleDeploy}
        onUnpause={() => ops.handlePause(false)}
      />

      <Tabs
        bordered
        value={activeTab}
        onValueChange={(value) => syncActiveTabInUrl(value as AssetManagementTab)}
      >
        <TabList className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {managementTabs.map((tab) => (
            <Tab key={tab.id} value={tab.id} className="shrink-0 whitespace-nowrap">
              {tab.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      {tokenError ? (
        <div className="rounded-xl border border-[rgba(220,38,38,0.2)] bg-[rgba(220,38,38,0.08)] px-4 py-3">
          <p className="text-sm font-medium text-[#dc2626]">{t("DashboardIssuance.workspace.tokenLoadWarning")}</p>
          <p className="mt-1 text-sm text-[#dc2626]">{tokenError}</p>
        </div>
      ) : null}

      {token.status === "paused" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[rgba(234,179,8,0.2)] bg-[rgba(234,179,8,0.08)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[#92400e]">{t("DashboardIssuance.workspace.tokenPaused")}</p>
            <p className="mt-1 text-sm text-[#92400e]">
              {t("DashboardIssuance.workspace.pausedHint")}
            </p>
          </div>
          {canManageTokenAdmin ? (
            <TokenDisabledActionTooltip
              reason={ops.isPending ? null : effectivePauseDisabledReason}
            >
              <Button
                type="button"
                size="sm"
                iconLeft={<Play />}
                onClick={() => ops.handlePause(false)}
                disabled={ops.isPending || Boolean(effectivePauseDisabledReason)}
              >
                {t("DashboardIssuance.workspace.unpauseToken")}
              </Button>
            </TokenDisabledActionTooltip>
          ) : null}
        </div>
      ) : null}

      <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        {activeTab === "overview" ? (
          <OverviewTab
            token={token}
            assetProfile={form.assetProfile}
            draft={form.draft}
            ops={ops}
            onDeploy={handleDeploy}
          />
        ) : null}
        {activeTab === "details" ? <DetailsTab token={token} form={form} ops={ops} /> : null}
        {activeTab === "public-info" ? (
          <PublicInfoTab
            draft={form.draft}
            disabled={form.saving}
            mintAddress={token.mintAddress}
            explorerHref={ops.explorerHref}
            onToggleField={(path, enabled) =>
              form.updateDraft({
                publicFields: togglePublicField(form.draft.publicFields, path, enabled),
              })
            }
          />
        ) : null}
        {activeTab === "compliance" ? (
          <ComplianceTab
            token={token}
            form={form}
            ops={ops}
            canManageTokenAdmin={canManageTokenAdmin}
          />
        ) : null}
        {activeTab === "operations" ? <OperationsTab ops={ops} /> : null}
        {activeTab === "permissions" ? (
          <PermissionsTab ops={ops} canManageTokenAdmin={canManageTokenAdmin} />
        ) : null}
      </motion.div>

      <AssetProfileSaveBar
        dirty={form.dirty}
        saving={form.saving}
        errorCount={form.showErrors ? form.errorCount : 0}
        onSave={() => void form.save()}
        onDiscard={form.discard}
      />

      <TokenAuthorityModal
        row={ops.authorityModalRow}
        currentAuthorityValue={ops.authorityModalCurrentAuthority}
        newAuthority={ops.authorityModalNewAuthority}
        authorityWallets={ops.authorityWallets}
        authorityWalletsError={ops.authorityWalletsError}
        signerUnavailableReason={ops.authorityModalSignerSelection.unavailableReason}
        isPending={ops.isPending}
        onNewAuthorityChange={ops.setAuthorityModalNewAuthority}
        onCancel={ops.handleAuthorityModalClose}
        onConfirm={ops.handleAuthorityModalConfirm}
      />

      <TokenManagementModalShell
        isOpen={Boolean(ops.fundManagementModalAction)}
        isPending={ops.isPending}
        onClose={ops.closeFundManagementModal}
      >
        {ops.fundManagementModalAction === "deploy" ? (
          <div className="rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
            <p className="pr-12 text-[20px] leading-[1.2] font-medium text-[#1c1c1d]">
              {t("DashboardIssuance.workspace.deployToken")}
            </p>
            <p className="mt-2 text-[14px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
              {t("DashboardIssuance.workspace.deployHint")}
            </p>
            <div className="mt-5 space-y-5">
              <TokenSignerSelect
                signerWallets={ops.deploySignerSelection.wallets}
                signerWalletId={ops.deploySignerWalletId}
                signerUnavailableReason={ops.deploySignerSelection.unavailableReason}
                onSignerWalletIdChange={ops.setDeploySignerWalletId}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={ops.closeFundManagementModal}
                  disabled={ops.isPending}
                  className="inline-flex h-10 items-center rounded-[12px] border border-[rgba(28,28,29,0.16)] bg-white px-4 text-sm font-medium text-[#1c1c1d] transition-colors hover:bg-[rgba(28,28,29,0.04)] disabled:pointer-events-none disabled:opacity-50"
                >
                  {t("DashboardIssuance.workspace.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => ops.submitFundManagementAction("deploy")}
                  disabled={ops.isPending || Boolean(ops.deploySignerSelection.unavailableReason)}
                  className="inline-flex h-10 items-center rounded-[12px] bg-[#0f0f10] px-4 text-sm font-medium text-white transition-colors hover:bg-black disabled:pointer-events-none disabled:opacity-50"
                >
                  {t("DashboardIssuance.workspace.deployNow")}
                </button>
              </div>
            </div>
          </div>
        ) : ops.fundManagementModalAction ? (
          <OpsActionForms
            ops={ops}
            token={token}
            activeAction={ops.fundManagementModalAction}
            submitAlignment="end"
            onMint={() => ops.submitFundManagementAction("mint")}
            onBurn={() => ops.submitFundManagementAction("burn")}
          />
        ) : null}
      </TokenManagementModalShell>

      <TokenActionConfirmationDialog
        actionConfirmation={ops.actionConfirmation}
        isPending={ops.isPending}
        onCancel={ops.dismissActionConfirmation}
        onConfirm={ops.confirmAction}
      />

      {ops.isPending ? (
        <div className="fixed right-4 bottom-4 z-30 inline-flex items-center gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] bg-white px-3 py-2 text-sm shadow-lg">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("DashboardIssuance.workspace.runningAction")}
        </div>
      ) : null}
    </div>
  );
}
