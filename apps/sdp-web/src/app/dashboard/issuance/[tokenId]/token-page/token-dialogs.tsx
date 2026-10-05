"use client";

import type { TokenOperations } from "../asset-profile/use-token-operations";
import { TokenActionConfirmationDialog } from "../token-action-confirmation-dialog";
import { TokenDeployWalletDialog } from "../token-deploy-wallet-dialog";

/**
 * The dialogs token operations go through, shared with the previous design's page: the signer
 * confirmation and the deploy's signing wallet. The page's tabs open them through `ops`; mint,
 * burn and lock supply open in place on Operations, and authorities in place on Permissions.
 */
export function TokenDialogs({ ops }: { ops: TokenOperations }) {
  return (
    <>
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
