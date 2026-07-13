"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";

interface TokenWalletIdentityCardProps {
  wallet?: PaymentsDashboardWallet | null;
  publicKey?: string | null;
  emptyLabel?: string;
  emptyDescription?: string;
}

export function TokenWalletIdentityCard({
  wallet,
  publicKey,
  emptyLabel,
  emptyDescription,
}: TokenWalletIdentityCardProps) {
  const t = useTranslations();
  const emptyWalletLabel = emptyLabel ?? t("DashboardIssuance.wallet.none");
  if (wallet) {
    const label = wallet.label?.trim() || t("DashboardIssuance.wallet.unlabeled");

    return (
      <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
        <p className="text-sm font-medium text-primary">{label}</p>
        <div className="mt-3 space-y-2">
          <IdentityRow label={t("DashboardIssuance.wallet.walletId")} value={wallet.walletId} />
          <IdentityRow
            label={t("DashboardIssuance.wallet.publicKey")}
            value={wallet.publicKey}
            monospace
          />
        </div>
      </div>
    );
  }

  if (publicKey?.trim()) {
    return (
      <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
        <p className="text-sm font-medium text-primary">
          {t("DashboardIssuance.wallet.customAddress")}
        </p>
        <div className="mt-3">
          <IdentityRow
            label={t("DashboardIssuance.wallet.publicKey")}
            value={publicKey}
            monospace
          />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3">
      <p className="text-sm font-medium text-primary">{emptyWalletLabel}</p>
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
