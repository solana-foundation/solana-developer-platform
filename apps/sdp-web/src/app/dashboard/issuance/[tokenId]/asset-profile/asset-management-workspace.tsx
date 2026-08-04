"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { Loader2, Play, WalletIcon } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { getTokenAccessControlMode, hasAccessControlList } from "../../access-control.utils";
import { togglePublicField } from "../../create/draft-mapping";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDisabledActionTooltip } from "../token-disabled-action-tooltip";
import type { FundManagementModalAction } from "../token-fund-management-section";
import { TokenLockSupplyModal } from "../token-lock-supply-modal";
import { TokenManagementModalShell } from "../token-management-modal-shell";
import { TokenSignerSelect } from "../token-signer-select";
import { AssetProfileHeader } from "./asset-profile-header";
import { AssetProfileSaveBar } from "./asset-profile-save-bar";
import { ActivityTab } from "./tabs/activity-tab";
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
  | "permissions"
  | "activity";

const managementTabIds: AssetManagementTab[] = [
  "overview",
  "details",
  "public-info",
  "compliance",
  "operations",
  "permissions",
  "activity",
];

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

/**
 * The deploy modal's card, stepped when the AlphaLedger engine flag is on:
 * step 1 is a tokenization-engine chooser with Vulcan Forge (coming soon,
 * disabled) and SDP with Mosaic, step 2 is the signer/fee deploy panel passed
 * as children, with wizard step pills and a Back affordance between them.
 * When the flag is off the card renders the deploy panel directly with no
 * step chrome. Mounted only while the deploy modal is open, so closing the
 * modal discards the choice and a reopen starts back at the chooser.
 *
 * @param enabled - Whether the chooser step and step chrome are shown.
 * @param children - Renders the signer/fee deploy panel content below the deploy title; receives a go-back handler for returning to the engine step, or null when the flow is not stepped.
 * @returns The stepped deploy modal card.
 */
function TokenizationEngineGate({
  enabled,
  children,
}: {
  enabled: boolean;
  children: (goBack: (() => void) | null) => ReactNode;
}) {
  const t = useTranslations();
  const [engineChosen, setEngineChosen] = useState(!enabled);

  const deployStepContent = (
    <>
      <p className="pr-12 text-[20px] leading-[1.2] font-medium text-primary">
        {t("DashboardIssuance.workspace.deployToken")}
      </p>
      <p className="mt-2 text-[14px] leading-[1.45] text-secondary">
        {t("DashboardIssuance.workspace.deployHint")}
      </p>
      {children(enabled ? () => setEngineChosen(false) : null)}
    </>
  );

  const engineStepContent = (
    <div className="flex h-full flex-col">
      <p className="pr-12 text-[20px] leading-[1.2] font-medium text-primary">
        {t("DashboardIssuance.management.tokenizationEngineTitle")}
      </p>
      <p className="mt-2 text-[14px] leading-[1.45] text-secondary">
        {t("DashboardIssuance.management.tokenizationEngineHint")}
      </p>
      <div className="mt-5 grid flex-1 gap-3 sm:grid-cols-2">
        <div className="flex cursor-not-allowed flex-col rounded-xl border border-border-default bg-fill-subtle p-5">
          <div className="flex flex-1 items-center justify-center py-10 opacity-50">
            <span className="inline-flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-[white]">
              <Image
                src="/provider-logos/alphaledger.svg"
                alt=""
                width={32}
                height={32}
                className="object-contain grayscale"
              />
            </span>
          </div>
          <div className="-mx-5 border-t border-border-default" />
          <div className="pt-4 text-left opacity-50">
            <p className="flex items-center gap-2 text-base font-medium text-primary">
              {t("DashboardIssuance.management.engineVulcanForgeName")}
              <span className="rounded-full border border-border-default bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-secondary">
                {t("DashboardIssuance.management.comingSoon")}
              </span>
            </p>
            <p className="mt-1 text-sm text-secondary">
              {t("DashboardIssuance.management.engineVulcanForgeDescription")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEngineChosen(true)}
          className="group flex flex-col rounded-xl border border-border-default bg-surface-raised p-5 transition-colors hover:bg-fill-subtle focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        >
          <span className="flex w-full flex-1 items-center justify-center py-10">
            <span className="inline-flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-[white] transition-transform duration-500 group-hover:scale-105 motion-reduce:transition-none">
              <Image
                src="/landing/solana-logo.svg"
                alt=""
                width={32}
                height={32}
                className="object-contain"
              />
            </span>
          </span>
          <span className="-mx-5 block border-t border-border-default" />
          <span className="block w-full pt-4 text-left">
            <span className="block text-base font-medium text-primary">
              {t("DashboardIssuance.management.engineMosaicName")}
            </span>
            <span className="mt-1 block text-sm text-secondary">
              {t("DashboardIssuance.management.engineMosaicDescription")}
            </span>
          </span>
        </button>
      </div>
    </div>
  );

  if (!enabled) {
    return (
      <div className="rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
        {deployStepContent}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
      <div className="mb-4 pr-12">
        <WizardStepProgress
          currentStep={engineChosen ? 1 : 0}
          progressLabel={t("DashboardIssuance.management.stepProgress", {
            current: engineChosen ? 2 : 1,
            total: 2,
          })}
          steps={[
            t("DashboardIssuance.management.engineStepLabel"),
            t("DashboardIssuance.management.deployStepLabel"),
          ]}
        />
      </div>
      {/* Both steps stay mounted in the same grid cell so the card keeps the
          taller step's height across transitions — no layout shift. */}
      <div className="grid">
        <motion.div
          key={engineChosen ? "deploy" : "engine"}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="col-start-1 row-start-1"
        >
          {engineChosen ? deployStepContent : engineStepContent}
        </motion.div>
        <div aria-hidden="true" className="invisible col-start-1 row-start-1">
          {engineChosen ? engineStepContent : deployStepContent}
        </div>
      </div>
    </div>
  );
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
  alphaledgerEngineEnabled,
}: {
  token: Token;
  assetProfile: AssetProfile;
  tokenError: string | null;
  alphaledgerEngineEnabled: boolean;
}) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const canManageTokenAdmin = dashboardAccess.capabilities.canManageTokenAdmin;
  // Admins get the full compliance tab (policy editor + controls). Non-admins
  // see it only for tokens that have a control list, and then only the allowlist
  // controls — the policy editor stays admin-only (also enforced server-side).
  const showControlList = hasAccessControlList(getTokenAccessControlMode(token));
  const canViewComplianceTab = canManageTokenAdmin || showControlList;
  const searchParams = useSearchParams();
  const { pushSearchParams, replaceSearchParams } = useDashboardUrlState();

  const requestedTabParam = searchParams.get("tab");
  const requestedTab = resolveTab(requestedTabParam);
  // A direct ?tab=compliance deep link falls back to the overview when the tab
  // isn't available to this user.
  const activeTab: AssetManagementTab =
    requestedTab === "compliance" && !canViewComplianceTab ? "overview" : requestedTab;
  const [pendingFundManagementModalAction, setPendingFundManagementModalAction] = useState<
    "deploy" | "mint" | "burn" | null
  >(null);
  const [onboardToVulcanForge, setOnboardToVulcanForge] = useState(false);

  const ops = useTokenOperations({
    token,
    shouldLoadSupportingData: activeTab !== "overview",
    // Authority wallets are also needed on the overview for the SDP-controlled
    // authorities tile (custody-vs-external roll-up), so load them everywhere.
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin,
  });
  const form = useAssetProfileForm({ token, assetProfile });
  const managementTabs: Array<{ id: AssetManagementTab; label: string }> = [
    { id: "overview", label: t("DashboardIssuance.tabs.overview") },
    { id: "details", label: t("DashboardIssuance.tabs.details") },
    { id: "public-info", label: t("DashboardIssuance.tabs.publicInformation") },
    // Full tab for admins; allowlist-only for non-admins on control-list tokens.
    ...(canViewComplianceTab
      ? [{ id: "compliance" as const, label: t("DashboardIssuance.tabs.compliance") }]
      : []),
    { id: "operations", label: t("DashboardIssuance.tabs.operations") },
    { id: "permissions", label: t("DashboardIssuance.tabs.permissions") },
    { id: "activity", label: t("DashboardIssuance.tabs.activity") },
  ];

  // Shallow update: the tabs are fully client-rendered, so a router.push RSC
  // refetch on every tab switch would only add latency.
  const syncActiveTabInUrl = useCallback(
    (nextTab: AssetManagementTab, mode: "push" | "replace" = "push") => {
      const sync = mode === "replace" ? replaceSearchParams : pushSearchParams;
      sync({ tab: nextTab === "overview" ? null : nextTab });
    },
    [pushSearchParams, replaceSearchParams]
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
    // Width + centering come from the dashboard shell's action-page layout;
    // the workspace just fills the column it's given.
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
        onCopyTokenId={() =>
          void ops.handleCopy(token.id, t("DashboardIssuance.management.tokenIdCopied"))
        }
        onDeploy={handleDeploy}
        onUnpause={() => ops.handlePause(false)}
      />

      <Tabs
        // No rule under the tab strip: the tab content below is already carded,
        // so the border would read as a second, competing edge.
        bordered={false}
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
        <div className="rounded-xl border border-error-border bg-error-bg px-4 py-3">
          <p className="text-sm font-medium text-error">
            {t("DashboardIssuance.workspace.tokenLoadWarning")}
          </p>
          <p className="mt-1 text-sm text-error">{tokenError}</p>
        </div>
      ) : null}

      {token.status === "paused" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-warning">
              {t("DashboardIssuance.workspace.tokenPaused")}
            </p>
            <p className="mt-1 text-sm text-warning">
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
            onViewActivity={() => syncActiveTabInUrl("activity")}
            onViewPermissions={() => syncActiveTabInUrl("permissions")}
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
        {activeTab === "operations" ? <OperationsTab ops={ops} tokenId={token.id} /> : null}
        {activeTab === "permissions" ? (
          <PermissionsTab ops={ops} canManageTokenAdmin={canManageTokenAdmin} />
        ) : null}
        {activeTab === "activity" ? <ActivityTab tokenId={token.id} /> : null}
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
          <TokenizationEngineGate enabled={alphaledgerEngineEnabled}>
            {(goBack) => (
              <div className="mt-5 space-y-5">
                <TokenSignerSelect
                  signerWallets={ops.deploySignerSelection.wallets}
                  signerWalletId={ops.deploySignerWalletId}
                  signerUnavailableReason={ops.deploySignerSelection.unavailableReason}
                  onSignerWalletIdChange={ops.setDeploySignerWalletId}
                  helperText={t("DashboardIssuance.management.deploySignerHint")}
                />
                {alphaledgerEngineEnabled ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border-default bg-fill-subtle p-4">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-[white]">
                        <Image
                          src="/provider-logos/alphaledger.svg"
                          alt=""
                          width={22}
                          height={22}
                          className="object-contain"
                        />
                      </span>
                      <div>
                        <p className="text-sm font-medium text-primary">
                          {t("DashboardIssuance.management.vulcanForgeOnboardTitle")}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-5 text-secondary">
                          {t("DashboardIssuance.management.vulcanForgeOnboardDescription")}
                        </p>
                      </div>
                    </div>
                    <ToggleSwitch
                      checked={onboardToVulcanForge}
                      onChange={setOnboardToVulcanForge}
                    />
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={goBack ? goBack : ops.closeFundManagementModal}
                    disabled={ops.isPending}
                    className="inline-flex h-10 items-center rounded-[12px] border border-border-default bg-surface-raised px-4 text-sm font-medium text-primary transition-colors hover:bg-fill-subtle disabled:pointer-events-none disabled:opacity-50"
                  >
                    {goBack
                      ? t("DashboardIssuance.create.back")
                      : t("DashboardIssuance.workspace.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => ops.deployToken("wallet")}
                    disabled={ops.isPending || Boolean(ops.deploySignerSelection.unavailableReason)}
                    className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-primary px-4 text-sm font-medium text-on-primary transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <WalletIcon className="size-4" />
                    {t("DashboardIssuance.management.deployWithWallet")}
                  </button>
                </div>
              </div>
            )}
          </TokenizationEngineGate>
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

      {/* Its own shell, not a fund-management branch: this flow stays open across
          submission so a failed revoke can be retried after a successful mint. */}
      <TokenManagementModalShell
        isOpen={ops.lockSupplyModalOpen && ops.lockSupplyRemaining !== null}
        isPending={ops.isPending}
        onClose={ops.closeLockSupplyModal}
      >
        {ops.lockSupplyRemaining !== null ? (
          <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
            <TokenLockSupplyModal
              token={token}
              remaining={ops.lockSupplyRemaining}
              alreadyMinted={ops.lockSupplyMinted}
              revokeFailed={ops.lockSupplyRevokeFailed}
              destination={ops.lockSupplyForm.destination}
              onDestinationChange={(destination) =>
                ops.setLockSupplyForm((previous) => ({ ...previous, destination }))
              }
              signerWallets={ops.lockSupplySignerSelection.wallets}
              signerWalletId={ops.lockSupplyForm.signingWalletId}
              signerUnavailableReason={ops.lockSupplySignerSelection.unavailableReason}
              onSignerWalletIdChange={(signingWalletId) =>
                ops.setLockSupplyForm((previous) => ({ ...previous, signingWalletId }))
              }
              isPending={ops.isPending}
              onCancel={ops.closeLockSupplyModal}
              onConfirm={() => void ops.handleLockSupply()}
            />
          </div>
        ) : null}
      </TokenManagementModalShell>

      <TokenActionConfirmationDialog
        actionConfirmation={ops.actionConfirmation}
        isPending={ops.isPending}
        onCancel={ops.dismissActionConfirmation}
        onConfirm={ops.confirmAction}
      />

      {ops.isPending ? (
        <div className="fixed right-4 bottom-4 z-30 inline-flex items-center gap-2 rounded-lg border border-border-default bg-surface-raised px-3 py-2 text-sm shadow-lg">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("DashboardIssuance.workspace.runningAction")}
        </div>
      ) : null}
    </div>
  );
}
