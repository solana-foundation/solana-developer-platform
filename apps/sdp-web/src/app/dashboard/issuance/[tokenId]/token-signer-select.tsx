"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { getSignerWalletOptionLabel } from "./token-management-workspace.utils";
import { TokenWalletIdentityCard } from "./token-wallet-identity-card";

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
  const isLocked = !isUnavailable && signerWallets.length === 1;
  // Red only signals a genuine problem: an explicit unavailable reason, or no
  // wallets in a context that requires a signer. An empty list where the signer
  // is optional (draft creation) is expected, so it stays neutral.
  const isError = hasReason || (hasNoWallets && !optional);
  const defaultMessage = isLocked
    ? t("DashboardIssuance.signer.requiredAuthorityHint")
    : t("DashboardIssuance.signer.selectedWalletHint");
  const availableMessage = helperText === undefined ? defaultMessage : helperText;
  const message = signerUnavailableReason
    ? signerUnavailableReason
    : hasNoWallets
      ? optional
        ? t("DashboardIssuance.signer.defaultSignerHint")
        : t("DashboardIssuance.signer.noneAvailable")
      : availableMessage;
  const selectedWallet =
    signerWallets.find((wallet) => wallet.walletId === signerWalletId) ?? signerWallets[0] ?? null;

  return (
    <div className="space-y-2">
      <span className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]">
        {label ?? t("DashboardIssuance.signer.label")}
      </span>
      {isLocked && selectedWallet ? (
        <TokenWalletIdentityCard wallet={selectedWallet} />
      ) : (
        <Select
          value={signerWalletId}
          disabled={isUnavailable}
          placeholder={t("DashboardIssuance.signer.select")}
          onValueChange={(value) => onSignerWalletIdChange(value === null ? "" : value)}
        >
          {signerWallets.map((wallet) => (
            <SelectItem key={wallet.id} value={wallet.walletId}>
              {getSignerWalletOptionLabel(wallet, t)}
            </SelectItem>
          ))}
        </Select>
      )}
      <p
        className={[
          "text-sm leading-5",
          isError ? "text-[#9e2b38]" : "text-[rgba(28,28,29,0.68)]",
        ].join(" ")}
      >
        {message}
      </p>
      {showSelectionSummary && !isUnavailable && selectedWallet && !isLocked ? (
        <TokenWalletIdentityCard wallet={selectedWallet} />
      ) : null}
    </div>
  );
}
