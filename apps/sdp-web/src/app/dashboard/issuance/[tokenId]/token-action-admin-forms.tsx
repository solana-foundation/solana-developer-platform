"use client";

import type { PaymentsDashboardWallet, TokenAllowlistEntry } from "@sdp/types";
import { type ComponentProps, type Dispatch, type SetStateAction, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { TokenActionCard } from "./token-action-card";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import type {
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  ForceBurnFormState,
  ForceBurnValidationErrors,
  FreezeFormState,
  SeizeFormState,
  SeizeValidationErrors,
} from "./token-management-workspace.types";
import {
  NON_WHITESPACE_PATTERN,
  SOLANA_ADDRESS_PATTERN,
  getTokenAmountFieldDescription,
} from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";
import { TokenValidationMessage } from "./token-validation-message";
import { TokenWalletAddressField } from "./token-wallet-address-field";

interface TokenActionAdminFormsProps {
  activeAction: AdminAction | null;
  isPending: boolean;
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
  seizeValidationErrors: SeizeValidationErrors;
  seizeValidationReason: string | null;
  forceBurnValidationErrors: ForceBurnValidationErrors;
  forceBurnValidationReason: string | null;
  submitAlignment?: "start" | "end";
  tokenStatus: "pending" | "active" | "paused" | "revoked";
  onSignerWalletIdChange: (value: string) => void;
  onSeize: () => void;
  onForceBurn: () => void;
  onAuthorityUpdate: () => void;
  onPause: (pause: boolean) => void;
  onFreeze: (unfreeze: boolean) => void;
  onAddAllowlist: () => void;
  onRemoveAllowlist: (entryId: string) => void;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: admin action forms intentionally centralize issuance control panels in one component.
export function TokenActionAdminForms({
  activeAction,
  isPending,
  seizeForm,
  setSeizeForm,
  forceBurnForm,
  setForceBurnForm,
  authorityForm,
  setAuthorityForm,
  freezeForm,
  setFreezeForm,
  allowlistForm,
  setAllowlistForm,
  allowlistEntries,
  allowlistError,
  controlListLabel,
  controlListDescription,
  controlListAddActionLabel,
  controlListEmptyState,
  freezeHint,
  signerWallets,
  defaultSignerWalletId = "",
  walletOptions,
  signerUnavailableReason,
  seizeValidationErrors,
  seizeValidationReason,
  forceBurnValidationErrors,
  forceBurnValidationReason,
  submitAlignment = "start",
  tokenStatus,
  onSignerWalletIdChange,
  onSeize,
  onForceBurn,
  onAuthorityUpdate,
  onPause,
  onFreeze,
  onAddAllowlist,
  onRemoveAllowlist,
}: TokenActionAdminFormsProps) {
  const t = useTranslations();
  return (
    <>
      {activeAction === "seize" ? (
        <TokenActionCard
          title={t("DashboardIssuance.compliance.forceTransfer")}
          description={t("DashboardIssuance.forms.forceTransferDescription")}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSeize();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={seizeForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <TokenWalletAddressField
              label={t("DashboardIssuance.forms.source")}
              value={seizeForm.source}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              placeholder={t("DashboardIssuance.forms.sourceWalletPlaceholder")}
              error={seizeValidationErrors.source}
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  source: value,
                }))
              }
            />
            <TokenWalletAddressField
              label={t("DashboardIssuance.forms.destination")}
              value={seizeForm.destination}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              placeholder={t("DashboardIssuance.forms.destinationPlaceholder")}
              error={seizeValidationErrors.destination}
              onChange={(value) =>
                setSeizeForm((previous) => ({
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
              value={seizeForm.amount}
              required
              error={seizeValidationErrors.amount}
              onChange={(value) =>
                setSeizeForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.memo")}
              value={seizeForm.memo}
              onChange={(value) =>
                setSeizeForm((previous) => ({
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
                  isPending || Boolean(signerUnavailableReason) || Boolean(seizeValidationReason)
                }
              >
                {t("DashboardIssuance.compliance.forceTransfer")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "force-burn" ? (
        <TokenActionCard
          title={t("DashboardIssuance.compliance.forceBurn")}
          description={t("DashboardIssuance.forms.forceBurnDescription")}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onForceBurn();
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={forceBurnForm.signingWalletId}
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <TokenWalletAddressField
              label={t("DashboardIssuance.forms.source")}
              value={forceBurnForm.source}
              walletOptions={walletOptions}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              placeholder={t("DashboardIssuance.forms.sourceWalletPlaceholder")}
              error={forceBurnValidationErrors.source}
              onChange={(value) =>
                setForceBurnForm((previous) => ({
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
              value={forceBurnForm.amount}
              required
              error={forceBurnValidationErrors.amount}
              onChange={(value) =>
                setForceBurnForm((previous) => ({
                  ...previous,
                  amount: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.memo")}
              value={forceBurnForm.memo}
              onChange={(value) =>
                setForceBurnForm((previous) => ({
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
                  isPending ||
                  Boolean(signerUnavailableReason) ||
                  Boolean(forceBurnValidationReason)
                }
              >
                {t("DashboardIssuance.compliance.forceBurn")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "authority" ? (
        <TokenActionCard
          title={t("DashboardIssuance.forms.updateAuthority")}
          description={t("DashboardIssuance.forms.updateAuthorityDescription")}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onAuthorityUpdate();
            }}
          >
            <ActionSelect
              label={t("DashboardIssuance.forms.role")}
              value={authorityForm.role}
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  role: value as AuthorityFormState["role"],
                }))
              }
              options={[
                { label: t("DashboardIssuance.forms.mintAuthority"), value: "mint" },
                { label: t("DashboardIssuance.forms.freezeAuthority"), value: "freeze" },
                {
                  label: t("DashboardIssuance.forms.permanentDelegate"),
                  value: "permanentDelegate",
                },
                { label: t("DashboardIssuance.forms.metadataAuthority"), value: "metadata" },
              ]}
            />
            <ActionField
              label={t("DashboardIssuance.forms.currentAuthorityOptional")}
              value={authorityForm.currentAuthority}
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  currentAuthority: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.newAuthorityEmptyToRemove")}
              value={authorityForm.newAuthority}
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              onChange={(value) =>
                setAuthorityForm((previous) => ({
                  ...previous,
                  newAuthority: value,
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
                {t("DashboardIssuance.management.updateAuthority")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "pause" ? (
        <TokenActionCard
          title={t("DashboardIssuance.forms.pauseControls")}
          description={t("DashboardIssuance.forms.pauseControlsDescription")}
        >
          <div className="space-y-4">
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={defaultSignerWalletId} // Always single locked wallet
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <div className="flex flex-wrap gap-2">
              <TokenDisabledActionTooltip
                reason={
                  tokenStatus === "paused" ? t("DashboardIssuance.forms.alreadyPaused") : null
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onPause(true)}
                  disabled={
                    isPending || tokenStatus === "paused" || Boolean(signerUnavailableReason)
                  }
                >
                  {t("DashboardIssuance.management.pauseToken")}
                </Button>
              </TokenDisabledActionTooltip>
              <TokenDisabledActionTooltip
                reason={tokenStatus === "active" ? t("DashboardIssuance.forms.notPaused") : null}
              >
                <Button
                  type="button"
                  onClick={() => onPause(false)}
                  disabled={
                    isPending || tokenStatus === "active" || Boolean(signerUnavailableReason)
                  }
                >
                  {t("DashboardIssuance.management.unpauseToken")}
                </Button>
              </TokenDisabledActionTooltip>
            </div>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "freeze" ? (
        <TokenActionCard
          title={t("DashboardIssuance.forms.freezeControls")}
          description={t("DashboardIssuance.forms.freezeControlsDescription")}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const submitter = (event.nativeEvent as SubmitEvent).submitter;
              const action = submitter instanceof HTMLButtonElement ? submitter.value : "freeze";
              onFreeze(action === "unfreeze");
            }}
          >
            <TokenSignerSelect
              signerWallets={signerWallets}
              signerWalletId={defaultSignerWalletId} // Always single locked wallet
              signerUnavailableReason={signerUnavailableReason}
              onSignerWalletIdChange={onSignerWalletIdChange}
            />
            <ActionField
              label={t("DashboardIssuance.forms.walletAddress")}
              value={freezeForm.accountAddress}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterWalletAddress")}
              placeholder={t("DashboardIssuance.forms.walletAddressPlaceholder")}
              onChange={(value) =>
                setFreezeForm((previous) => ({
                  ...previous,
                  accountAddress: value,
                }))
              }
            />
            <p className="text-sm leading-6 text-[rgba(28,28,29,0.64)]">
              {t("DashboardIssuance.forms.walletAddressInstruction")}
            </p>
            {freezeHint ? (
              <p className="text-sm leading-6 text-[rgba(28,28,29,0.64)]">{freezeHint}</p>
            ) : null}
            <ActionField
              label={t("DashboardIssuance.forms.freezeReason")}
              value={freezeForm.reason}
              onChange={(value) =>
                setFreezeForm((previous) => ({
                  ...previous,
                  reason: value,
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
                variant="outline"
                value="freeze"
                disabled={isPending || Boolean(signerUnavailableReason)}
              >
                {t("DashboardIssuance.management.freezeAccount")}
              </Button>
              <Button
                type="submit"
                value="unfreeze"
                disabled={isPending || Boolean(signerUnavailableReason)}
              >
                {t("DashboardIssuance.management.unfreezeAccount")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "allowlist" && controlListLabel ? (
        <TokenActionCard
          title={controlListLabel}
          description={
            controlListDescription ?? t("DashboardIssuance.forms.controlListDescription")
          }
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onAddAllowlist();
            }}
          >
            <ActionField
              label={t("DashboardIssuance.forms.address")}
              value={allowlistForm.address}
              required
              pattern={SOLANA_ADDRESS_PATTERN}
              title={t("DashboardIssuance.forms.enterSolanaAddress")}
              onChange={(value) =>
                setAllowlistForm((previous) => ({
                  ...previous,
                  address: value,
                }))
              }
            />
            <ActionField
              label={t("DashboardIssuance.forms.label")}
              value={allowlistForm.label}
              pattern={NON_WHITESPACE_PATTERN}
              title={t("DashboardIssuance.forms.enterLabel")}
              onChange={(value) =>
                setAllowlistForm((previous) => ({
                  ...previous,
                  label: value,
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
                {controlListAddActionLabel}
              </Button>
            </div>

            {allowlistError ? (
              <TokenValidationMessage message={allowlistError} reserveSpace={false} />
            ) : allowlistEntries.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.68)]">{controlListEmptyState}</p>
            ) : (
              <div className="space-y-2">
                {allowlistEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-[#1c1c1d]">{entry.address}</p>
                      <p className="text-xs text-[rgba(28,28,29,0.62)]">
                        {entry.label ?? t("DashboardIssuance.forms.noLabel")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRemoveAllowlist(entry.id)}
                      disabled={isPending}
                    >
                      {t("DashboardIssuance.forms.removeEntry")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
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
