"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";

interface TokenWalletIdentityCardProps {
  wallet?: PaymentsDashboardWallet | null;
  publicKey?: string | null;
  emptyLabel?: string;
  emptyDescription?: string;
}

export function TokenWalletIdentityCard({
  wallet,
  publicKey,
  emptyLabel = "None",
  emptyDescription,
}: TokenWalletIdentityCardProps) {
  if (wallet) {
    const label = wallet.label?.trim() || "Unlabeled wallet";

    return (
      <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
        <p className="text-sm font-medium text-primary">{label}</p>
        <div className="mt-3 space-y-2">
          <IdentityRow label="Wallet ID" value={wallet.walletId} />
          <IdentityRow label="Public key" value={wallet.publicKey} monospace />
        </div>
      </div>
    );
  }

  if (publicKey?.trim()) {
    return (
      <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
        <p className="text-sm font-medium text-primary">Custom address</p>
        <div className="mt-3">
          <IdentityRow label="Public key" value={publicKey} monospace />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
      <p className="text-sm font-medium text-primary">{emptyLabel}</p>
      {emptyDescription ? (
        <p className="mt-1 text-sm leading-[1.45] text-secondary">{emptyDescription}</p>
      ) : null}
    </div>
  );
}

function IdentityRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] leading-4 font-medium tracking-[0.02em] text-tertiary uppercase">
        {label}
      </p>
      <p
        className={["mt-1 break-all text-sm text-primary", monospace ? "font-mono" : ""].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}
