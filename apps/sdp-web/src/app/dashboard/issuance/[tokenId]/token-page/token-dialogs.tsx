"use client";

import type { Token } from "@sdp/types";
import type { TokenOperations } from "../asset-profile/use-token-operations";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDeployWalletDialog } from "../token-deploy-wallet-dialog";
import { TokenLockSupplyModal } from "../token-lock-supply-modal";
import { TokenManagementModalShell } from "../token-management-modal-shell";

/**
 * The dialogs token operations go through, shared with the previous design's page: lock
 * supply, moving an authority, the signer confirmation and the deploy's signing wallet. The
 * page's tabs open them through `ops`; mint and burn open in place on Operations.
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
