"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { type ComponentProps, type Dispatch, type SetStateAction, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenActionCard } from "./token-action-card";
import type {
  AdminAction,
  BurnFormState,
  BurnValidationErrors,
  MetadataFormState,
  MintFormState,
  MintValidationErrors,
} from "./token-management-workspace.types";
import { NON_WHITESPACE_PATTERN, SOLANA_ADDRESS_PATTERN } from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";
import { TokenValidationMessage } from "./token-validation-message";
import { TokenWalletAddressField } from "./token-wallet-address-field";

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
  walletOptions: PaymentsDashboardWallet[];
  signerUnavailableReason: string | null;
  mintValidationErrors: MintValidationErrors;
  mintValidationReason: string | null;
  burnValidationErrors: BurnValidationErrors;
  burnValidationReason: string | null;
  submitAlignment?: "start" | "end";
  onSignerWalletIdChange: (value: string) => void;
  onUpdateMetadata: () => void;
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
  walletOptions,
  signerUnavailableReason,
  mintValidationErrors,
  mintValidationReason,
  burnValidationErrors,
  burnValidationReason,
  submitAlignment = "start",
  onSignerWalletIdChange,
  onUpdateMetadata,
  onMint,
  onBurn,
}: TokenActionPrimaryFormsProps) {
  return (
    <>
      {activeAction === "update-metadata" ? (
        <TokenActionCard title="Update Metadata" description="Edit token metadata.">
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
            <div
              className={[
                "flex flex-wrap gap-2",
                submitAlignment === "end" ? "justify-end" : "",
              ].join(" ")}
            >
              <Button type="submit" disabled={isPending}>
                Save metadata
              </Button>
            </div>
          </form>
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
            <TokenWalletAddressField
              label="Destination"
              value={mintForm.destination}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              placeholder="Destination wallet or token account"
              error={mintValidationErrors.destination}
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
              error={mintValidationErrors.amount}
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
            <div
              className={[
                "flex flex-wrap gap-2",
                submitAlignment === "end" ? "justify-end" : "",
              ].join(" ")}
            >
              <Button
                type="submit"
                disabled={
                  isPending || Boolean(signerUnavailableReason) || Boolean(mintValidationReason)
                }
              >
                Mint tokens
              </Button>
            </div>
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
            <TokenWalletAddressField
              label="Source"
              value={burnForm.source}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title="Enter a valid Solana address."
              placeholder="Signer wallet or its token account"
              error={burnValidationErrors.source}
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
              error={burnValidationErrors.amount}
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
            <div
              className={[
                "flex flex-wrap gap-2",
                submitAlignment === "end" ? "justify-end" : "",
              ].join(" ")}
            >
              <Button
                type="submit"
                disabled={
                  isPending || Boolean(signerUnavailableReason) || Boolean(burnValidationReason)
                }
              >
                Burn tokens
              </Button>
            </div>
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
  error,
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
  error?: string | null;
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
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
      />
      <TokenValidationMessage message={error ?? null} />
    </div>
  );
}
