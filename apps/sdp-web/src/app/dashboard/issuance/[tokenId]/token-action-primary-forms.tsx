"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { type ComponentProps, type Dispatch, type SetStateAction, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { TokenActionCard } from "./token-action-card";
import type {
  AdminAction,
  BurnFormState,
  BurnValidationErrors,
  MetadataFormState,
  MintFormState,
  MintValidationErrors,
} from "./token-management-workspace.types";
import {
  getTokenAmountFieldDescription,
  NON_WHITESPACE_PATTERN,
  SOLANA_ADDRESS_PATTERN,
} from "./token-management-workspace.utils";
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
  const t = useTranslations();
  // Mirrors the non-pending half of each submit button's `disabled` condition so the
  // note adjacent to the button explains why the action is unavailable (e.g. the
  // destination is denylisted) without the user having to scan the form fields.
  const mintDisabledReason = signerUnavailableReason || mintValidationReason;
  const burnDisabledReason = signerUnavailableReason || burnValidationReason;

  return (
    <>
      {activeAction === "update-metadata" ? (
        <TokenActionCard
          title={t("DashboardIssuance.forms.updateMetadata")}
          description={t("DashboardIssuance.forms.updateMetadataDescription")}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onUpdateMetadata();
            }}
          >
            <ActionField
              label={t("DashboardIssuance.forms.name")}
              value={metadataForm.name}
              required
              pattern={NON_WHITESPACE_PATTERN}
              title={t("DashboardIssuance.forms.enterTokenName")}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  name: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.description")}
              value={metadataForm.description}
              onChange={(value) =>
                setMetadataForm((previous) => ({
                  ...previous,
                  description: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.uri")}
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
              label={t("DashboardIssuance.forms.imageUrl")}
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
                {t("DashboardIssuance.forms.saveMetadata")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "mint" ? (
        <TokenActionCard
          title={t("DashboardIssuance.management.mintTokens")}
          description={t("DashboardIssuance.forms.mintDescription")}
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
              label={t("DashboardIssuance.forms.destination")}
              value={mintForm.destination}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              placeholder={t("DashboardIssuance.forms.destinationPlaceholder")}
              error={mintValidationErrors.destination}
              onChange={(value) =>
                setMintForm((previous) => ({
                  ...previous,
                  destination: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.amount")}
              description={getTokenAmountFieldDescription(t)}
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
              label={t("DashboardIssuance.forms.memo")}
              value={mintForm.memo}
              onChange={(value) =>
                setMintForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <div className="space-y-2">
              <TokenValidationMessage
                message={
                  !isPending && mintDisabledReason
                    ? `Mint unavailable — ${mintDisabledReason}`
                    : null
                }
                reserveSpace={false}
                announce={false}
              />
              <div
                className={[
                  "flex flex-wrap gap-2",
                  submitAlignment === "end" ? "justify-end" : "",
                ].join(" ")}
              >
                <Button type="submit" disabled={isPending || Boolean(mintDisabledReason)}>
                  {t("DashboardIssuance.management.mintTokens")}
                </Button>
              </div>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "burn" ? (
        <TokenActionCard
          title={t("DashboardIssuance.management.burnTokens")}
          description={t("DashboardIssuance.forms.burnDescription")}
        >
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
              label={t("DashboardIssuance.forms.source")}
              value={burnForm.source}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              placeholder={t("DashboardIssuance.forms.sourcePlaceholder")}
              error={burnValidationErrors.source}
              onChange={(value) =>
                setBurnForm((previous) => ({
                  ...previous,
                  source: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.amount")}
              description={getTokenAmountFieldDescription(t)}
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
              label={t("DashboardIssuance.forms.memo")}
              value={burnForm.memo}
              onChange={(value) =>
                setBurnForm((previous) => ({
                  ...previous,
                  memo: value,
                }))
              }
            />
            <div className="space-y-2">
              <TokenValidationMessage
                message={
                  !isPending && burnDisabledReason
                    ? `Burn unavailable — ${burnDisabledReason}`
                    : null
                }
                reserveSpace={false}
                announce={false}
              />
              <div
                className={[
                  "flex flex-wrap gap-2",
                  submitAlignment === "end" ? "justify-end" : "",
                ].join(" ")}
              >
                <Button type="submit" disabled={isPending || Boolean(burnDisabledReason)}>
                  {t("DashboardIssuance.management.burnTokens")}
                </Button>
              </div>
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
  description,
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
  description?: string;
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
      {description ? (
        <p className="text-[13px] leading-5 text-[rgba(28,28,29,0.62)]">{description}</p>
      ) : null}
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
