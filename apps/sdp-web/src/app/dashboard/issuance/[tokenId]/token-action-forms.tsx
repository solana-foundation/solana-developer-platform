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
  ForceBurnFormState,
  FreezeFormState,
  MetadataFormState,
  MintFormState,
  SeizeFormState,
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
  signerWallets: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  onUpdateMetadata: () => void;
  onRefreshSupply: () => void;
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
        signerUnavailableReason={props.signerUnavailableReason}
        onSignerWalletIdChange={props.onSignerWalletIdChange}
        onUpdateMetadata={props.onUpdateMetadata}
        onRefreshSupply={props.onRefreshSupply}
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
        signerWallets={props.signerWallets}
        signerUnavailableReason={props.signerUnavailableReason}
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
