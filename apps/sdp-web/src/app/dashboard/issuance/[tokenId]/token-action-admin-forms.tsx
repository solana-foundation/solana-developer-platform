"use client";

import type { PaymentsDashboardWallet, TokenAllowlistEntry } from "@sdp/types";
import {
  Flame,
  HandCoins,
  Inbox,
  Info,
  Pause,
  Play,
  Plus,
  Search,
  Snowflake,
  Sun,
  Trash2,
  UserCog,
} from "lucide-react";
import {
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useId,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
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
  getTokenAmountFieldDescription,
  NON_WHITESPACE_PATTERN,
  SOLANA_ADDRESS_PATTERN,
} from "./token-management-workspace.utils";
import { TokenSignerSelect } from "./token-signer-select";
import { TokenValidationMessage } from "./token-validation-message";
import { TokenWalletAddressField } from "./token-wallet-address-field";
import { useInlineValidationMessage } from "./use-inline-validation-message";

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
  // Forwarded to TokenActionCard; also gates the per-button icons (see there).
  variant?: "card" | "flat" | "bare";
  hideAllowlistTitle?: boolean;
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
  variant = "card",
  hideAllowlistTitle = false,
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
  // Non-card surfaces prefix each action button with an icon; the legacy card
  // keeps them icon-free. One map so the form tree isn't duplicated to toggle icons.
  const icon: Partial<
    Record<
      | "seize"
      | "forceBurn"
      | "authority"
      | "pause"
      | "unpause"
      | "freeze"
      | "unfreeze"
      | "addEntry"
      | "removeEntry",
      ReactNode
    >
  > =
    variant !== "card"
      ? {
          seize: <HandCoins />,
          forceBurn: <Flame />,
          authority: <UserCog />,
          pause: <Pause />,
          unpause: <Play />,
          freeze: <Snowflake />,
          unfreeze: <Sun />,
          addEntry: <Plus />,
          removeEntry: <Trash2 />,
        }
      : {};
  return (
    <>
      {activeAction === "seize" ? (
        <TokenActionCard
          variant={variant}
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
              hideFilterHint={variant !== "card"}
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
              hideFilterHint={variant !== "card"}
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
                iconLeft={icon.seize}
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
          variant={variant}
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
              hideFilterHint={variant !== "card"}
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
                iconLeft={icon.forceBurn}
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
          variant={variant}
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
              <Button type="submit" iconLeft={icon.authority} disabled={isPending}>
                {t("DashboardIssuance.management.updateAuthority")}
              </Button>
            </div>
          </form>
        </TokenActionCard>
      ) : null}

      {activeAction === "pause" ? (
        <TokenActionCard
          variant={variant}
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
            <div
              className={[
                "flex flex-wrap gap-2",
                submitAlignment === "end" ? "justify-end" : "",
              ].join(" ")}
            >
              <TokenDisabledActionTooltip
                reason={
                  tokenStatus === "paused" ? t("DashboardIssuance.forms.alreadyPaused") : null
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  iconLeft={icon.pause}
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
                  iconLeft={icon.unpause}
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
          variant={variant}
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
            <div className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-fill-subtle p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-tertiary" aria-hidden />
              <div className="space-y-2">
                <p className="text-sm leading-5 text-secondary">
                  {t("DashboardIssuance.forms.walletAddressInstruction")}
                </p>
                {freezeHint ? (
                  <p className="text-sm leading-5 text-secondary">{freezeHint}</p>
                ) : null}
              </div>
            </div>
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
                iconLeft={icon.freeze}
                disabled={isPending || Boolean(signerUnavailableReason)}
              >
                {t("DashboardIssuance.management.freezeAccount")}
              </Button>
              <Button
                type="submit"
                value="unfreeze"
                iconLeft={icon.unfreeze}
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
          variant={variant}
          title={hideAllowlistTitle ? undefined : controlListLabel}
          description={
            hideAllowlistTitle
              ? undefined
              : (controlListDescription ?? t("DashboardIssuance.forms.controlListDescription"))
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
              <Button type="submit" iconLeft={icon.addEntry} disabled={isPending}>
                {controlListAddActionLabel}
              </Button>
            </div>

            {allowlistError ? (
              <TokenValidationMessage message={allowlistError} reserveSpace={false} />
            ) : null}

            <ControlListEntries
              entries={allowlistEntries}
              emptyState={controlListEmptyState}
              searchPlaceholder={t("DashboardIssuance.controlLists.searchPlaceholder", {
                label: controlListLabel,
              })}
              removeIcon={icon.removeEntry}
              isPending={isPending}
              onRemove={onRemoveAllowlist}
            />
          </form>
        </TokenActionCard>
      ) : null}
    </>
  );
}

// Search + label-filter + list for a control list; filtering is client-side over
// the loaded entries.
function ControlListEntries({
  entries,
  emptyState,
  searchPlaceholder,
  removeIcon,
  isPending,
  onRemove,
}: {
  entries: TokenAllowlistEntry[];
  emptyState: string;
  searchPlaceholder: string;
  removeIcon: ReactNode;
  isPending: boolean;
  onRemove: (entryId: string) => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState("all");

  // Distinct labels on the loaded entries feed the "All labels" dropdown.
  const labels = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.label) {
        seen.add(entry.label);
      }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  // Fall back to "all" if the selected label vanished (its last entry was removed).
  const activeLabel = labelFilter !== "all" && labels.includes(labelFilter) ? labelFilter : "all";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (activeLabel !== "all" && entry.label !== activeLabel) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return `${entry.address} ${entry.label ?? ""}`.toLowerCase().includes(needle);
    });
  }, [entries, query, activeLabel]);

  return (
    <div className="space-y-3 border-t border-border-subtle pt-4">
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={searchPlaceholder}
          iconLeft={<Search />}
        />
        <Select
          className="w-44 shrink-0"
          value={activeLabel}
          onValueChange={(value) => setLabelFilter(value ?? "all")}
          ariaLabel={t("DashboardIssuance.controlLists.filterByLabel")}
        >
          <SelectItem value="all">{t("DashboardIssuance.controlLists.allLabels")}</SelectItem>
          {labels.map((label) => (
            <SelectItem key={label} value={label}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border-default px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-primary">{entry.address}</p>
                <p className="text-xs text-secondary">
                  {entry.label ?? t("DashboardIssuance.forms.noLabel")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                iconLeft={removeIcon}
                onClick={() => onRemove(entry.id)}
                disabled={isPending}
              >
                {t("DashboardIssuance.forms.removeEntry")}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Inbox className="h-6 w-6 text-tertiary" />
          <p className="text-sm text-secondary">
            {entries.length === 0 ? emptyState : t("DashboardIssuance.controlLists.noMatches")}
          </p>
        </div>
      )}
    </div>
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
  const errorId = useId();
  const { message: nativeError, onInvalid, revalidate } = useInlineValidationMessage(label);
  const hasError = Boolean(error) || nativeError !== null;

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-secondary"
      >
        {label}
      </label>
      {description ? <p className="text-[13px] leading-5 text-secondary">{description}</p> : null}
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
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : undefined}
        onInvalid={onInvalid}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          revalidate(event.currentTarget);
        }}
        className="h-11 rounded-[12px] border-border-default bg-surface-raised px-4 shadow-none"
      />
      <TokenValidationMessage id={errorId} message={error ?? nativeError} />
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
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-secondary"
      >
        {label}
      </label>
      <select
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-11 w-full rounded-[12px] border border-border-default bg-surface-raised px-4 text-sm text-primary shadow-none outline-none transition-[box-shadow,border-color] focus:border-border-strong focus:ring-2 focus:ring-border-default"
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
