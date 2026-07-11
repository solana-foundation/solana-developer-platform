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
  emptyLabel = "None",
  emptyDescription,
}: TokenWalletIdentityCardProps) {
  const t = useTranslations();
  const emptyWalletLabel = emptyLabel ?? t("DashboardIssuance.wallet.none");
  if (wallet) {
    const label = wallet.label?.trim() || t("DashboardIssuance.wallet.unlabeled");

    return (
      <div className="rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
        <p className="text-sm font-medium text-[#1c1c1d]">{label}</p>
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
      <div className="rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
        <p className="text-sm font-medium text-[#1c1c1d]">
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
    <div className="rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
      <p className="text-sm font-medium text-[#1c1c1d]">{emptyWalletLabel}</p>
      {emptyDescription ? (
        <p className="mt-1 text-sm leading-[1.45] text-[rgba(28,28,29,0.68)]">{emptyDescription}</p>
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
      <p className="text-[11px] leading-4 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.54)] uppercase">
        {label}
      </p>
      <p
        className={["mt-1 break-all text-sm text-[#1c1c1d]", monospace ? "font-mono" : ""].join(
          " "
        )}
      >
        {value}
      </p>
    </div>
  );
}
