"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { KeyRound, type LucideIcon, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
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
      <IdentityShell testId="wallet-identity-card">
        {/* Same provider mark the custody wallet cards use (logo, else key glyph). */}
        <WalletProviderMark provider={wallet.provider} />
        <div className="min-w-0 flex-1">
          {wallet.provider ? <Eyebrow>{formatCustodyProviderName(wallet.provider)}</Eyebrow> : null}
          <p className="text-[15px] leading-6 font-semibold tracking-[-0.1px] text-primary">
            {label}
          </p>
          <div className="mt-2.5 space-y-2">
            <IdentityRow
              icon={Wallet}
              label={t("DashboardIssuance.wallet.walletId")}
              value={wallet.walletId}
            />
            <IdentityRow
              icon={KeyRound}
              label={t("DashboardIssuance.wallet.publicKey")}
              value={wallet.publicKey}
            />
          </div>
        </div>
      </IdentityShell>
    );
  }

  if (publicKey?.trim()) {
    return (
      <IdentityShell>
        {/* Raw external address — no provider, so the neutral key fallback. */}
        <WalletProviderMark provider={null} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-6 font-semibold tracking-[-0.1px] text-primary">
            {t("DashboardIssuance.wallet.customAddress")}
          </p>
          <div className="mt-2.5">
            <IdentityRow
              icon={KeyRound}
              label={t("DashboardIssuance.wallet.publicKey")}
              value={publicKey}
            />
          </div>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell>
      <WalletProviderMark provider={null} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-6 font-semibold tracking-[-0.1px] text-primary">
          {emptyWalletLabel}
        </p>
        {emptyDescription ? (
          <p className="mt-1 text-sm leading-[1.45] text-secondary">{emptyDescription}</p>
        ) : null}
      </div>
    </IdentityShell>
  );
}

function IdentityShell({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-3 rounded-[12px] border border-border-default bg-fill-subtle px-4 py-3"
    >
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] leading-4 font-medium tracking-[0.06em] text-tertiary uppercase">
      {children}
    </p>
  );
}

function IdentityRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] leading-4 font-medium tracking-[0.04em] text-tertiary uppercase">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </p>
      <p className="mt-1 break-all text-xs leading-5 text-primary">{value}</p>
    </div>
  );
}
