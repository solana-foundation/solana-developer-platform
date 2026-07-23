"use client";

import type { Token } from "@sdp/types";
import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { TokenActionForms } from "../../token-action-forms";
import type { AdminAction } from "../../token-management-workspace.types";
import { createInitialMetadataForm } from "../../token-management-workspace.utils";
import type { TokenOperations } from "../use-token-operations";

/**
 * Binds the reusable TokenActionForms to the operations hook. The
 * "update-metadata" action is never activated here — token metadata is edited
 * through the workspace's save-bar flow instead — so the metadata form state is
 * an inert placeholder required by the props contract.
 */
export function OpsActionForms({
  ops,
  token,
  activeAction,
  submitAlignment = "start",
  formVariant = "flat",
  onMint,
  onBurn,
}: {
  ops: TokenOperations;
  token: Token;
  activeAction: AdminAction | null;
  submitAlignment?: "start" | "end";
  // Panel chrome. "flat" (default) draws each form's own bordered panel (the
  // fund-management modal needs it); "bare" drops it for the compliance tab,
  // which wraps the whole controls column in one card.
  formVariant?: "flat" | "bare";
  // Overridable for modal contexts that need to close before submitting.
  onMint?: () => void;
  onBurn?: () => void;
}) {
  const t = useTranslations();
  const [metadataForm, setMetadataForm] = useState(() => createInitialMetadataForm(token));
  const signerProps = ops.getActionSignerProps(activeAction);

  return (
    <TokenActionForms
      activeAction={activeAction}
      isPending={ops.isPending}
      tokenStatus={token.status}
      metadataForm={metadataForm}
      setMetadataForm={setMetadataForm}
      mintForm={ops.mintForm}
      setMintForm={ops.setMintForm}
      burnForm={ops.burnForm}
      setBurnForm={ops.setBurnForm}
      seizeForm={ops.seizeForm}
      setSeizeForm={ops.setSeizeForm}
      forceBurnForm={ops.forceBurnForm}
      setForceBurnForm={ops.setForceBurnForm}
      authorityForm={ops.authorityForm}
      setAuthorityForm={ops.setAuthorityForm}
      freezeForm={ops.freezeForm}
      setFreezeForm={ops.setFreezeForm}
      allowlistForm={ops.allowlistForm}
      setAllowlistForm={ops.setAllowlistForm}
      allowlistEntries={ops.allowlistEntries}
      allowlistError={ops.allowlistError}
      controlListLabel={ops.controlListCopy?.label ?? null}
      controlListDescription={ops.controlListCopy?.description ?? null}
      controlListAddActionLabel={
        ops.controlListCopy?.addActionLabel ?? t("DashboardIssuance.management.addAllowlistEntry")
      }
      controlListEmptyState={
        ops.controlListCopy?.emptyState ?? t("DashboardIssuance.management.noAllowlistEntries")
      }
      freezeHint={ops.controlListCopy?.freezeHint ?? null}
      signerWallets={signerProps.signerWallets}
      defaultSignerWalletId={signerProps.defaultSignerWalletId}
      walletOptions={ops.authorityWallets}
      signerUnavailableReason={signerProps.signerUnavailableReason}
      mintValidationErrors={ops.mintValidationErrors}
      mintValidationReason={ops.mintValidationReason}
      burnValidationErrors={ops.burnValidationErrors}
      burnValidationReason={ops.burnValidationReason}
      seizeValidationErrors={ops.seizeValidationErrors}
      seizeValidationReason={ops.seizeValidationReason}
      forceBurnValidationErrors={ops.forceBurnValidationErrors}
      forceBurnValidationReason={ops.forceBurnValidationReason}
      submitAlignment={submitAlignment}
      variant={formVariant}
      onSignerWalletIdChange={signerProps.onSignerWalletIdChange}
      onUpdateMetadata={() => {}}
      onMint={onMint ?? ops.handleMint}
      onBurn={onBurn ?? ops.handleBurn}
      onSeize={ops.handleSeize}
      onForceBurn={ops.handleForceBurn}
      onAuthorityUpdate={ops.handleAuthorityUpdate}
      onPause={ops.handlePause}
      onFreeze={ops.handleFreeze}
      onAddAllowlist={ops.handleAddAllowlist}
      onRemoveAllowlist={ops.handleRemoveAllowlist}
    />
  );
}
