"use client";

import type { TokenAllowlistEntry } from "@sdp/types";
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
  onUpdateMetadata: () => void;
  onRefreshSupply: () => void;
  onMint: (mode: "prepare" | "execute") => void;
  onBurn: (mode: "prepare" | "execute") => void;
  onSeize: (mode: "prepare" | "execute") => void;
  onForceBurn: (mode: "prepare" | "execute") => void;
  onAuthorityUpdate: (mode: "prepare" | "execute") => void;
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
        onUpdateMetadata={props.onUpdateMetadata}
        onRefreshSupply={props.onRefreshSupply}
        onMint={props.onMint}
        onBurn={props.onBurn}
      />
      <TokenActionAdminForms
        activeAction={props.activeAction}
        isPending={props.isPending}
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
