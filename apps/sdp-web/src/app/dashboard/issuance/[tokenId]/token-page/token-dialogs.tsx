"use client";

import type { Token } from "@sdp/types";
import { OpsActionForms } from "../asset-profile/tabs/ops-action-forms";
import type { TokenOperations } from "../asset-profile/use-token-operations";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDeployWalletDialog } from "../token-deploy-wallet-dialog";
import { TokenLockSupplyModal } from "../token-lock-supply-modal";
import { TokenManagementModalShell } from "../token-management-modal-shell";

/**
 * The dialogs every token operation goes through, shared with the previous design's page:
 * mint and burn, lock supply, moving an authority, the signer confirmation and the deploy's
 * signing wallet. The page's tabs open them through `ops`.
 */
export function TokenDialogs({ ops, token }: { ops: TokenOperations; token: Token }) {
  return (
    <>
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

      {/* Its own shell: the flow stays open across submission so a failed revoke can be
          retried after a successful mint. */}
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
    </>
  );
}
