"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { toWalletIdentity, WalletIdentityBadge } from "../wallet-identity";
import {
  getSignerWalletOptionLabel,
  getSignerWalletUnavailableReason,
} from "./token-management-workspace.utils";

interface TokenSignerSelectProps {
  signerWallets: PaymentsDashboardWallet[];
  signerWalletId: string;
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  label?: string;
  /** Overrides the default signing helper line when the selection is available. */
  helperText?: string;
  showSelectionSummary?: boolean;
  /** When true, an empty wallet list is an expected/optional state (e.g. draft
   *  creation, which falls back to the project's default signer) rather than a
   *  blocking error — keeps the helper text neutral instead of red. */
  optional?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: availability, lock and message visibility are one decision about the same selection; splitting them would hide how they depend on each other.
export function TokenSignerSelect({
  signerWallets,
  signerWalletId,
  signerUnavailableReason,
  onSignerWalletIdChange,
  label,
  helperText,
  showSelectionSummary = false,
  optional = false,
}: TokenSignerSelectProps) {
  const t = useTranslations();
  const hasReason = Boolean(signerUnavailableReason);
  const hasNoWallets = !hasReason && signerWallets.length === 0;
  const isUnavailable = hasReason || signerWallets.length === 0;
  const selectedWallet =
    signerWallets.find((wallet) => wallet.id === signerWalletId) ??
    (!signerWalletId && signerWallets.length === 1 ? signerWallets[0] : null);
  const selectionUnavailableReason = optional
    ? null
    : getSignerWalletUnavailableReason(signerWallets, signerWalletId || selectedWallet?.id, t);
  // ponytail: runtime disablement is recognised by its copy, not a kind flag —
  // every reason producer renders it through this same key.
  // TODO: at the next touch of getSignerWalletUnavailableReason, return
  // { message, kind } and drop this string comparison.
  const runtimeReason = t("DashboardIssuance.management.signingUnavailable");
  // A restricted wallet is still the signer, so it keeps its identity row; only a
  // structural reason (no authority, not controlled, load failure) hides it.
  const structuralReason = hasReason && signerUnavailableReason !== runtimeReason;
  // A disappeared explicit choice must stay editable, not display a replacement.
  const isLocked = !structuralReason && signerWallets.length === 1 && selectedWallet !== null;
  const hasDuplicateAddress =
    new Set(signerWallets.map((wallet) => wallet.publicKey)).size < signerWallets.length;
  // Red only signals a genuine problem: an explicit unavailable reason, or no
  // wallets in a context that requires a signer. An empty list where the signer
  // is optional (draft creation) is expected, so it stays neutral.
  const isError = hasReason || Boolean(selectionUnavailableReason) || (hasNoWallets && !optional);
  const defaultMessage = isLocked
    ? t("DashboardIssuance.signer.requiredAuthorityHint")
    : t("DashboardIssuance.signer.selectedWalletHint");
  const availableMessage = helperText === undefined ? defaultMessage : helperText;
  const message =
    signerUnavailableReason ??
    selectionUnavailableReason ??
    (hasNoWallets
      ? optional
        ? t("DashboardIssuance.signer.defaultSignerHint")
        : t("DashboardIssuance.signer.noneAvailable")
      : availableMessage);
  const isRuntimeOnly = message === runtimeReason;
  const summaryShown =
    showSelectionSummary && !isUnavailable && selectedWallet !== null && !isLocked;
  // An identity row shows a runtime restriction itself, so the sentence is not
  // repeated under it.
  const rowCarriesStatus = isRuntimeOnly && (isLocked || summaryShown);
  const messageTone = !isError
    ? "text-secondary"
    : isRuntimeOnly
      ? "text-warning"
      : "text-destructive-strong";
  return (
    <div className="space-y-2">
      <span className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-secondary">
        {label ?? t("DashboardIssuance.signer.label")}
      </span>
      {isLocked && selectedWallet ? (
        // Keep the operation open while inspecting its signing wallet.
        <WalletIdentityBadge
          variant="row"
          walletLink="new-tab"
          identity={toWalletIdentity(selectedWallet, null, {
            unresolvedAs: "custom",
            unlabeled: t("DashboardIssuance.wallet.unlabeled"),
          })}
        />
      ) : (
        <Select
          value={selectedWallet?.id ?? ""}
          disabled={isUnavailable}
          placeholder={t("DashboardIssuance.signer.select")}
          onValueChange={(value) => onSignerWalletIdChange(value === null ? "" : value)}
        >
          {signerWallets.map((wallet) => (
            <SelectItem
              key={wallet.id}
              value={wallet.id}
              disabled={!optional && wallet.isRuntimeExecutionAllowed !== true}
            >
              {getSignerWalletOptionLabel(wallet, t, hasDuplicateAddress)}
            </SelectItem>
          ))}
        </Select>
      )}
      {/* Under a locked row only an explicit helper is spelled out: a structural
          reason never locks, and a runtime one is on the row. */}
      {message && !rowCarriesStatus && (!isLocked || helperText !== undefined) ? (
        <p className={`text-sm leading-5 ${messageTone}`}>{message}</p>
      ) : null}
      {summaryShown && selectedWallet ? (
        // Summary of a live selection — the surrounding form holds unsaved state,
        // so inspecting the wallet opens beside it rather than replacing it.
        <WalletIdentityBadge
          variant="row"
          walletLink="new-tab"
          identity={toWalletIdentity(selectedWallet, null, {
            unresolvedAs: "custom",
            unlabeled: t("DashboardIssuance.wallet.unlabeled"),
          })}
        />
      ) : null}
    </div>
  );
}
