"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { ChevronDown, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { getDraftDeploymentBlocker } from "../../draft-permissions";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenLockSupplyModal } from "../token-lock-supply-modal";
import { TokenManagementModalShell } from "../token-management-modal-shell";
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

  const ops = useTokenOperations({
    token,
    shouldLoadSupportingData: true,
    // Authority wallets are also needed on the overview for the SDP-controlled
    // authorities tile (custody-vs-external roll-up), so load them everywhere.
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin,
  });
  const form = useAssetProfileForm({ token, assetProfile });
  const draftDeploymentBlocker = getDraftDeploymentBlocker(
    form.draft.authorityWalletIds,
    form.draft.signingWalletId
  );
  const showSection = useCallback((section: AssetManagementTab) => {
    const element = document.getElementById(`token-${section}`);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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

      <div className="w-full divide-y divide-border-subtle [&>details]:min-w-0">
        <details id="token-operations" open className="group scroll-mt-6 py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.tabs.operations")}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pt-4">
            <OperationsTab ops={ops} token={token} canManageTokenAdmin={canManageTokenAdmin} />
          </div>
        </details>
        <details id="token-permissions" open className="group scroll-mt-6 py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.tabs.permissions")}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pt-4">
            <PermissionsTab ops={ops} form={form} canManageTokenAdmin={canManageTokenAdmin} />
          </div>
        </details>
        <details id="token-settings" className="group scroll-mt-6 py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.simplified.settings")}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pt-5">
            <DetailsTab token={token} form={form} />
          </div>
        </details>
        <details id="token-activity" className="group scroll-mt-6 py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.tabs.activity")}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pt-4">
            <ActivityTab tokenId={token.id} isDraft={!token.mintAddress} />
          </div>
        </details>
      </div>

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
