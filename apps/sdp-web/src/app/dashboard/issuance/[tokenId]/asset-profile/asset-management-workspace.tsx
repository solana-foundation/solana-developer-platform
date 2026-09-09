"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { getDraftDeploymentBlocker } from "../../draft-permissions";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDeployWalletDialog } from "../token-deploy-wallet-dialog";
import { TokenLockSupplyModal } from "../token-lock-supply-modal";
import { TokenManagementModalShell } from "../token-management-modal-shell";
import { TokenSignerSelect } from "../token-signer-select";
import { AnimatedSection } from "./animated-section";
import { AssetProfileHeader } from "./asset-profile-header";
import { AssetProfileSaveBar } from "./asset-profile-save-bar";
import { ActivityTab } from "./tabs/activity-tab";
import { DetailsTab } from "./tabs/details-tab";
import { OperationsTab } from "./tabs/operations-tab";
import { OpsActionForms } from "./tabs/ops-action-forms";
import { PermissionsTab } from "./tabs/permissions-tab";
import { useAssetProfileForm } from "./use-asset-profile-form";
import { useTokenOperations } from "./use-token-operations";

type AssetManagementTab = "overview" | "settings" | "operations" | "permissions" | "activity";

const managementTabIds: AssetManagementTab[] = [
  "overview",
  "operations",
  "permissions",
  "activity",
  "settings",
];

// Deep links minted for the legacy workspace keep working.
const LEGACY_TAB_MAP: Record<string, AssetManagementTab> = {
  "fund-management": "operations",
  metadata: "settings",
  details: "settings",
  "public-info": "settings",
  extensions: "settings",
  compliance: "operations",
  workflows: "overview",
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
  const { dashboardAccess, sdpEnvironment } = useDashboardWorkspace();
  const canManageTokenAdmin = dashboardAccess.capabilities.canManageTokenAdmin;
  const searchParams = useSearchParams();

  const requestedTabParam = searchParams.get("tab");
  const requestedTab = resolveTab(requestedTabParam);
  const reducedMotion = useReducedMotion();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ operations: true });
  const toggleSection = (section: string, open: boolean) =>
    setOpenSections((current) => ({ ...current, [section]: open }));

  const ops = useTokenOperations({
    token,
    shouldLoadSupportingData: true,
    // Authority wallets are also needed on the overview for the SDP-controlled
    // authorities tile (custody-vs-external roll-up), so load them everywhere.
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin,
  });
  const form = useAssetProfileForm({
    token,
    assetProfile,
    metadataSignerSelection: ops.metadataSignerSelection,
  });
  const draftDeploymentBlockerKey = getDraftDeploymentBlocker(
    form.draft.authorityWalletIds,
    form.draft.signingWalletId
  );
  const draftDeploymentBlocker = draftDeploymentBlockerKey ? t(draftDeploymentBlockerKey) : null;
  const showSection = useCallback(
    (section: AssetManagementTab) => {
      setOpenSections((current) => ({ ...current, [section]: true }));
      const element = document.getElementById(`token-${section}`);
      element?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
    },
    [reducedMotion]
  );

  // Existing tab links now reveal the corresponding section on the same page.
  useEffect(() => {
    if (requestedTabParam && requestedTab !== "overview") showSection(requestedTab);
  }, [requestedTabParam, requestedTab, showSection]);

  return (
    // Width + centering come from the dashboard shell's action-page layout;
    // the workspace just fills the column it's given.
    <div className="space-y-5 px-1 pb-8 sm:space-y-6 sm:px-0">
      <div className="space-y-4 sm:space-y-5 sm:py-2">
        <AssetProfileHeader
          token={token}
          assetProfile={form.assetProfile}
          networkLabel={sdpEnvironment === "production" ? "Mainnet" : "Devnet"}
          explorerHref={ops.explorerHref}
          canDeployToken={ops.canDeployToken}
          isPending={ops.isPending}
          deployDisabledReason={
            form.dirty
              ? t("DashboardIssuance.simplified.saveBeforeDeploy")
              : draftDeploymentBlocker || ops.deployDisabledReason
          }
          pauseDisabledReason={ops.effectivePauseDisabledReason}
          canManageTokenAdmin={canManageTokenAdmin}
          onCopyAddress={() => void ops.handleCopy(token.mintAddress)}
          onCopyTokenId={() =>
            void ops.handleCopy(token.id, t("DashboardIssuance.management.tokenIdCopied"))
          }
          onDeploy={() => {
            if (!form.dirty && !draftDeploymentBlocker) ops.deployToken();
          }}
          onUnpause={() => ops.handlePause(false)}
          onRefreshSupply={ops.handleRefreshSupply}
          isRefreshingSupply={ops.isRefreshingSupply}
        />
      </div>

      {tokenError ? (
        <div className="rounded-xl border border-error-border bg-error-bg px-4 py-3">
          <p className="text-sm font-medium text-error">
            {t("DashboardIssuance.workspace.tokenLoadWarning")}
          </p>
          <p className="mt-1 text-sm text-error">{tokenError}</p>
        </div>
      ) : null}

      <div className="w-full divide-y divide-border-subtle [&>section]:min-w-0">
        <AnimatedSection
          id="token-operations"
          title={t("DashboardIssuance.tabs.operations")}
          open={openSections.operations}
          onOpenChange={(open) => toggleSection("operations", open)}
        >
          <div className="pt-4">
            {ops.isPending ? (
              <p role="status" className="mb-3 flex items-center gap-2 text-sm text-secondary">
                <Loader2 className="size-4 animate-spin" />
                {t("DashboardIssuance.ux.working")}
              </p>
            ) : null}
            <OperationsTab ops={ops} token={token} canManageTokenAdmin={canManageTokenAdmin} />
          </div>
        </AnimatedSection>
        <AnimatedSection
          id="token-permissions"
          title={t("DashboardIssuance.tabs.permissions")}
          open={openSections.permissions ?? false}
          onOpenChange={(open) => toggleSection("permissions", open)}
        >
          <div className="pt-4">
            <PermissionsTab ops={ops} form={form} canManageTokenAdmin={canManageTokenAdmin} />
          </div>
        </AnimatedSection>
        <AnimatedSection
          id="token-settings"
          title={t("DashboardIssuance.simplified.settings")}
          open={openSections.settings ?? false}
          onOpenChange={(open) => toggleSection("settings", open)}
        >
          <div className="pt-5">
            <DetailsTab token={token} form={form} />
          </div>
        </AnimatedSection>
        <AnimatedSection
          id="token-activity"
          title={t("DashboardIssuance.tabs.activity")}
          open={openSections.activity ?? false}
          onOpenChange={(open) => toggleSection("activity", open)}
        >
          <div className="pt-4">
            <ActivityTab tokenId={token.id} isDraft={!token.mintAddress} />
          </div>
        </AnimatedSection>
      </div>

      <AssetProfileSaveBar
        dirty={form.dirty}
        saving={form.saving}
        errorCount={form.showErrors ? form.errorCount : 0}
        onSave={() => void form.save()}
        onDiscard={form.discard}
      >
        {form.requiresMetadataSigner &&
        (ops.metadataSignerSelection.wallets.length !== 1 ||
          ops.metadataSignerSelection.wallets[0]?.id !== form.metadataSignerWalletId ||
          ops.metadataSignerSelection.unavailableReason) ? (
          <TokenSignerSelect
            signerWallets={ops.metadataSignerSelection.wallets}
            signerWalletId={form.metadataSignerWalletId}
            signerUnavailableReason={ops.metadataSignerSelection.unavailableReason}
            onSignerWalletIdChange={form.setMetadataSignerWalletId}
          />
        ) : null}
      </AssetProfileSaveBar>

      <TokenAuthorityModal
        row={ops.authorityModalRow}
        currentAuthorityValue={ops.authorityModalCurrentAuthority}
        newAuthority={ops.authorityModalNewAuthority}
        authorityWallets={ops.authorityWallets}
        authorityWalletsError={ops.authorityWalletsError}
        signerWallets={ops.authorityModalSignerSelection.wallets}
        signerWalletId={ops.authorityModalSignerWalletId}
        signerUnavailableReason={ops.authorityModalSignerSelection.unavailableReason}
        isPending={ops.isPending}
        onNewAuthorityChange={ops.setAuthorityModalNewAuthority}
        onSignerWalletIdChange={ops.setAuthorityModalSignerWalletId}
        onCancel={ops.handleAuthorityModalClose}
        onConfirm={ops.handleAuthorityModalConfirm}
      />

      <TokenManagementModalShell
        isOpen={Boolean(ops.fundManagementModalAction)}
        isPending={ops.isPending}
        onClose={ops.closeFundManagementModal}
      >
        {ops.fundManagementModalAction ? (
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
        onSignerWalletIdChange={ops.selectConfirmationWallet}
      />

      <TokenDeployWalletDialog
        isOpen={ops.deployWalletDialogOpen}
        isPending={ops.isPending}
        signerWallets={ops.deploySignerSelection.wallets}
        signerUnavailableReason={ops.deploySignerSelection.unavailableReason}
        signingCustodyWalletId={ops.deployCustodyWalletId}
        onSigningCustodyWalletIdChange={ops.setDeployCustodyWalletId}
        onCancel={ops.closeDeployWalletDialog}
        onConfirm={ops.confirmDeployWallet}
      />
    </div>
  );
}
