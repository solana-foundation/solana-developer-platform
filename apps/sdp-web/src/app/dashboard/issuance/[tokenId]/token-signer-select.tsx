"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useId } from "react";
import { getSignerWalletOptionLabel } from "./token-management-workspace.utils";
import { TokenWalletIdentityCard } from "./token-wallet-identity-card";

interface TokenSignerSelectProps {
  signerWallets: PaymentsDashboardWallet[];
  signerWalletId: string;
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  label?: string;
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
  label = "Signer",
  showSelectionSummary = false,
  optional = false,
}: TokenSignerSelectProps) {
  const fieldId = useId();
  const hasReason = Boolean(signerUnavailableReason);
  const hasNoWallets = !hasReason && signerWallets.length === 0;
  const isUnavailable = hasReason || signerWallets.length === 0;
  const isLocked = !isUnavailable && signerWallets.length === 1;
  // Red only signals a genuine problem: an explicit unavailable reason, or no
  // wallets in a context that requires a signer. An empty list where the signer
  // is optional (draft creation) is expected, so it stays neutral — and we never
  // say "the selected wallet" when there is nothing to select.
  const isError = hasReason || (hasNoWallets && !optional);
  const message = hasReason
    ? signerUnavailableReason
    : hasNoWallets
      ? optional
        ? "No signer wallets available — SDP will use the project's default signer."
        : "No signer wallets available."
      : isLocked
        ? "SDP will sign this action with the required authority wallet."
        : "SDP will sign this transaction with the selected wallet.";
  const selectedWallet =
    signerWallets.find((wallet) => wallet.walletId === signerWalletId) ?? signerWallets[0] ?? null;

  return (
    <div className="space-y-2">
      <label
        htmlFor={fieldId}
        className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
      >
        {label}
      </label>
      {isLocked && selectedWallet ? (
        <TokenWalletIdentityCard wallet={selectedWallet} />
      ) : (
        <select
          id={fieldId}
          value={signerWalletId}
          required={!isUnavailable}
          disabled={isUnavailable}
          onChange={(event) => onSignerWalletIdChange(event.currentTarget.value)}
          className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d] shadow-none outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)] disabled:cursor-not-allowed disabled:bg-[rgba(28,28,29,0.04)] disabled:text-[rgba(28,28,29,0.45)]"
        >
          <option value="" disabled>
            Select a signer wallet
          </option>
          {signerWallets.map((wallet) => (
            <option key={wallet.id} value={wallet.walletId}>
              {getSignerWalletOptionLabel(wallet)}
            </option>
          ))}
        </select>
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
