"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { type ComponentProps, type Dispatch, type SetStateAction, useId } from "react";
import { TokenActionCard } from "./token-action-card";
import type {
  AdminAction,
  BurnFormState,
  MetadataFormState,
  MintFormState,
} from "./token-management-workspace.types";
import { NON_WHITESPACE_PATTERN, SOLANA_ADDRESS_PATTERN } from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";

interface TokenActionPrimaryFormsProps {
  activeAction: AdminAction | null;
  isPending: boolean;
  metadataForm: MetadataFormState;
  setMetadataForm: Dispatch<SetStateAction<MetadataFormState>>;
  mintForm: MintFormState;
  setMintForm: Dispatch<SetStateAction<MintFormState>>;
  burnForm: BurnFormState;
  setBurnForm: Dispatch<SetStateAction<BurnFormState>>;
  signerWallets: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  onUpdateMetadata: () => void;
  onRefreshSupply: () => void;
  onMint: () => void;
  onBurn: () => void;
}

export function TokenActionPrimaryForms({
  activeAction,
  isPending,
  metadataForm,
  setMetadataForm,
  mintForm,
  setMintForm,
  burnForm,
  setBurnForm,
  signerWallets,
  signerUnavailableReason,
  onSignerWalletIdChange,
  onUpdateMetadata,
  onRefreshSupply,
  onMint,
  onBurn,
}: TokenActionPrimaryFormsProps) {
  return (
    <>
      {activeAction === "update-metadata" ? (
        <TokenActionCard title="Update Metadata" description="Edit token metadata and status.">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onUpdateMetadata();
            }}
          >
            <ActionField
              label="Name"
              value={metadataForm.name}
              required
              pattern={NON_WHITESPACE_PATTERN}
              title="Enter a token name."
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  name: value,
                }))
              }
            />
            <ActionSelect
              label="Status"
              value={metadataForm.status}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  status: value as "active" | "paused",
                }))
              }
              options={[
                { label: "active", value: "active" },
                { label: "paused", value: "paused" },
              ]}
            />
            <ActionField
              label="Description"
              value={metadataForm.description}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  description: value,
                }))
              }
            />
            <ActionField
              label="URI"
              type="url"
              inputMode="url"
              value={metadataForm.uri}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  uri: value,
                }))
              }
            />
            <ActionField
              label="Image URL"
              type="url"
              inputMode="url"
              value={metadataForm.imageUrl}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  imageUrl: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending}>
              Save metadata
            </Button>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "refresh-supply" ? (
        <TokenActionCard
          title="Refresh Supply"
          description="Fetch supply from RPC and update cache."
        >
          <Button type="button" variant="secondary" onClick={onRefreshSupply} disabled={isPending}>
            Refresh supply
          </Button>
        </TokenActionCard>
      ) : null}

      {activeAction === "mint" ? (
        <TokenActionCard
          title="Mint Tokens"
          description="Mint to destination wallet/token account."
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onMint();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={mintForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <ActionField
              label="Destination"
              value={mintForm.destination}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setMintForm((previous) => ({
                  ...previous,
                  destination: value,
                }))
              }
            />
            <ActionField
              label="Amount"
              type="number"
              inputMode="decimal"
              min="0.000000001"
              step="any"
              value={mintForm.amount}
              required
              onChange={(value) =>
                setMintForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label="Memo"
              value={mintForm.memo}
              onChange={(value) =>
                setMintForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
              Mint tokens
            </Button>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "burn" ? (
        <TokenActionCard title="Burn Tokens" description="Burn from source wallet/token account.">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onBurn();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={burnForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <ActionField
              label="Source"
              value={burnForm.source}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              onChange={(value) =>
                setBurnForm((previous) => ({
                  ...previous,
                  source: value,
                }))
              }
            />
            <ActionField
              label="Amount"
              type="number"
              inputMode="decimal"
              min="0.000000001"
              step="any"
              value={burnForm.amount}
              required
              onChange={(value) =>
                setBurnForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label="Memo"
              value={burnForm.memo}
              onChange={(value) =>
                setBurnForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <Button type="submit" disabled={isPending || Boolean(signerUnavailableReason)}>
              Burn tokens
            </Button>
          </form>
        </TokenActionCard>
      ) : null}
    </>
  );
}

function ActionField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  pattern,
  title,
  min,
  step,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: ComponentProps<typeof Input>["type"];
  required?: boolean;
  pattern?: string;
  title?: string;
  min?: string;
  step?: string;
  placeholder?: string;
  inputMode?: ComponentProps<typeof Input>["inputMode"];
}) {
  const fieldId = useId();

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
      >
        {label}
      </label>
      <Input
        id={fieldId}
        type={type}
        value={value}
        required={required}
        pattern={pattern}
        title={title}
        min={min}
        step={step}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
      />
    </div>
  );
}

function ActionSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  const fieldId = useId();

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
      >
        {label}
      </label>
      <select
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d] shadow-none outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
