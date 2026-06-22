"use client";

import type { PaymentsDashboardWallet, TokenAllowlistEntry } from "@sdp/types";
import type { Dispatch, SetStateAction } from "react";
import { TokenActionAdminForms } from "./token-action-admin-forms";
import { TokenActionPrimaryForms } from "./token-action-primary-forms";
import type {
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  BurnFormState,
  BurnValidationErrors,
  ForceBurnFormState,
  ForceBurnValidationErrors,
  FreezeFormState,
  MetadataFormState,
  MintFormState,
  MintValidationErrors,
  SeizeFormState,
  SeizeValidationErrors,
} from "./token-management-workspace.types";

interface TokenActionFormsProps {
  activeAction: AdminAction | null;
  isPending: boolean;
  tokenStatus: "pending" | "active" | "paused" | "revoked";
  metadataForm: MetadataFormState;
  setMetadataForm: Dispatch<SetStateAction<MetadataFormState>>;
  mintForm: MintFormState;
  setMintForm: Dispatch<SetStateAction<MintFormState>>;
  burnForm: BurnFormState;
  setBurnForm: Dispatch<SetStateAction<BurnFormState>>;
  seizeForm: SeizeFormState;
  setSeizeForm: Dispatch<SetStateAction<SeizeFormState>>;
  forceBurnForm: ForceBurnFormState;
  setForceBurnForm: Dispatch<SetStateAction<ForceBurnFormState>>;
  authorityForm: AuthorityFormState;
  setAuthorityForm: Dispatch<SetStateAction<AuthorityFormState>>;
  freezeForm: FreezeFormState;
  setFreezeForm: Dispatch<SetStateAction<FreezeFormState>>;
  allowlistForm: AllowlistFormState;
  setAllowlistForm: Dispatch<SetStateAction<AllowlistFormState>>;
  allowlistEntries: TokenAllowlistEntry[];
  allowlistError: string | null;
  controlListLabel: string | null;
  controlListDescription: string | null;
  controlListAddActionLabel: string;
  controlListEmptyState: string;
  freezeHint: string | null;
  signerWallets: PaymentsDashboardWallet[];
  defaultSignerWalletId?: string;
  walletOptions: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  mintValidationErrors: MintValidationErrors;
  mintValidationReason: string | null;
  burnValidationErrors: BurnValidationErrors;
  burnValidationReason: string | null;
  seizeValidationErrors: SeizeValidationErrors;
  seizeValidationReason: string | null;
  forceBurnValidationErrors: ForceBurnValidationErrors;
  forceBurnValidationReason: string | null;
  submitAlignment?: "start" | "end";
  onSignerWalletIdChange: (value: string) => void;
  onUpdateMetadata: () => void;
  onMint: () => void;
  onBurn: () => void;
  onSeize: () => void;
  onForceBurn: () => void;
  onAuthorityUpdate: () => void;
  onPause: (pause: boolean) => void;
  onFreeze: (unfreeze: boolean) => void;
  onAddAllowlist: () => void;
  onRemoveAllowlist: (entryId: string) => void;
}

export function TokenActionForms(props: TokenActionFormsProps) {
  return (
    <>
      <TokenActionPrimaryForms
        activeAction={props.activeAction}
        isPending={props.isPending}
        metadataForm={props.metadataForm}
        setMetadataForm={props.setMetadataForm}
        mintForm={props.mintForm}
        setMintForm={props.setMintForm}
        burnForm={props.burnForm}
        setBurnForm={props.setBurnForm}
        signerWallets={props.signerWallets}
        walletOptions={props.walletOptions}
        signerUnavailableReason={props.signerUnavailableReason}
        mintValidationErrors={props.mintValidationErrors}
        mintValidationReason={props.mintValidationReason}
        burnValidationErrors={props.burnValidationErrors}
        burnValidationReason={props.burnValidationReason}
        submitAlignment={props.submitAlignment}
        onSignerWalletIdChange={props.onSignerWalletIdChange}
        onUpdateMetadata={props.onUpdateMetadata}
        onMint={props.onMint}
        onBurn={props.onBurn}
      />
      <TokenActionAdminForms
        activeAction={props.activeAction}
        isPending={props.isPending}
        tokenStatus={props.tokenStatus}
        seizeForm={props.seizeForm}
        setSeizeForm={props.setSeizeForm}
        forceBurnForm={props.forceBurnForm}
        setForceBurnForm={props.setForceBurnForm}
        authorityForm={props.authorityForm}
        setAuthorityForm={props.setAuthorityForm}
        freezeForm={props.freezeForm}
        setFreezeForm={props.setFreezeForm}
        allowlistForm={props.allowlistForm}
        setAllowlistForm={props.setAllowlistForm}
        allowlistEntries={props.allowlistEntries}
        allowlistError={props.allowlistError}
        controlListLabel={props.controlListLabel}
        controlListDescription={props.controlListDescription}
        controlListAddActionLabel={props.controlListAddActionLabel}
        controlListEmptyState={props.controlListEmptyState}
        freezeHint={props.freezeHint}
        signerWallets={props.signerWallets}
        defaultSignerWalletId={props.defaultSignerWalletId}
        walletOptions={props.walletOptions}
        signerUnavailableReason={props.signerUnavailableReason}
        seizeValidationErrors={props.seizeValidationErrors}
        seizeValidationReason={props.seizeValidationReason}
        forceBurnValidationErrors={props.forceBurnValidationErrors}
        forceBurnValidationReason={props.forceBurnValidationReason}
        submitAlignment={props.submitAlignment}
        onSignerWalletIdChange={props.onSignerWalletIdChange}
        onSeize={props.onSeize}
        onForceBurn={props.onForceBurn}
        onAuthorityUpdate={props.onAuthorityUpdate}
        onPause={props.onPause}
        onFreeze={props.onFreeze}
        onAddAllowlist={props.onAddAllowlist}
        onRemoveAllowlist={props.onRemoveAllowlist}
      />
    </>
  );
}
