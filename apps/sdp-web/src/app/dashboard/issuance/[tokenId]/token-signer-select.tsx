"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { Select, SelectItem } from "@/components/ui/select";
import { getSignerWalletOptionLabel } from "./token-management-workspace.utils";
import { TokenWalletIdentityCard } from "./token-wallet-identity-card";

interface TokenSignerSelectProps {
  signerWallets: PaymentsDashboardWallet[];
  signerWalletId: string;
  signerUnavailableReason: string | null;
  onSignerWalletIdChange: (value: string) => void;
  label?: string;
  showSelectionSummary?: boolean;
}

export function TokenSignerSelect({
  signerWallets,
  signerWalletId,
  signerUnavailableReason,
  onSignerWalletIdChange,
  label = "Signer",
  showSelectionSummary = false,
}: TokenSignerSelectProps) {
  const isUnavailable = Boolean(signerUnavailableReason) || signerWallets.length === 0;
  const isLocked = !isUnavailable && signerWallets.length === 1;
  const message = signerUnavailableReason
    ? signerUnavailableReason
    : isLocked
      ? "SDP will sign this action with the required authority wallet."
      : "SDP will sign this transaction with the selected wallet.";
  const selectedWallet =
    signerWallets.find((wallet) => wallet.walletId === signerWalletId) ?? signerWallets[0] ?? null;

  return (
    <div className="space-y-2">
      <span className="block text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]">
        {label}
      </span>
      {isLocked && selectedWallet ? (
        <TokenWalletIdentityCard wallet={selectedWallet} />
      ) : (
        <Select
          value={signerWalletId}
          disabled={isUnavailable}
          placeholder="Select a signer wallet"
          onValueChange={(value) => onSignerWalletIdChange(value === null ? "" : value)}
        >
          {signerWallets.map((wallet) => (
            <SelectItem key={wallet.id} value={wallet.walletId}>
              {getSignerWalletOptionLabel(wallet)}
            </SelectItem>
          ))}
        </Select>
      )}
      <p
        className={[
          "text-sm leading-5",
          isUnavailable ? "text-[#9e2b38]" : "text-[rgba(28,28,29,0.68)]",
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
