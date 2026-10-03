"use client";

import type { TokenOperations } from "../asset-profile/use-token-operations";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenAuthorityModal } from "../token-authority-modal";
import { TokenDeployWalletDialog } from "../token-deploy-wallet-dialog";

/**
 * The dialogs token operations go through, shared with the previous design's page: moving an
 * authority, the signer confirmation and the deploy's signing wallet. The page's tabs open them
 * through `ops`; mint, burn and lock supply open in place on Operations.
 */
export function TokenDialogs({ ops }: { ops: TokenOperations }) {
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
