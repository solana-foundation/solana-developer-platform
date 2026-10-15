"use client";

import type { ReactNode } from "react";
import { TokenSignerSelect } from "../token-signer-select";
import type { TokenTabProps } from "./token-page.shared";

/**
 * The wallet that signs a deployed token's metadata change, in the save footer: hidden when
 * the only candidate is already picked, a picker otherwise, and the reason when none can sign.
 * Shared by the Details and Public information tabs, whose saves both rewrite the metadata.
 */
export function MetadataSigner({ ops, form }: Pick<TokenTabProps, "ops" | "form">): ReactNode {
  const selection = ops.metadataSignerSelection;
  if (
    selection.wallets.length === 1 &&
    selection.wallets[0]?.id === form.metadataSignerWalletId &&
    !selection.unavailableReason
  ) {
    return null;
  }
  return (
    <TokenSignerSelect
      signerWallets={selection.wallets}
      signerWalletId={form.metadataSignerWalletId}
      signerUnavailableReason={selection.unavailableReason}
      onSignerWalletIdChange={form.setMetadataSignerWalletId}
    />
  );
}
