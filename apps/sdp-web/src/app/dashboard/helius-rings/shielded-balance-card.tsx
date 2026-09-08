"use client";

import { formatCurrencyAmount } from "@/app/dashboard/payments/payments-overview.utils";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { RingsWallet } from "./helius-rings.data";
import { RekeyWalletDialog } from "./rekey-wallet-dialog";
import { useRingsBalance } from "./use-rings-balance";

/**
 * One wallet's shielded balance in the wallets table. Auto-syncs on mount and
 * whenever the workspace signals a completed operation; there's no refresh
 * button here — that lives on the Wallet Overview above the composer.
 */
export function ShieldedBalanceCard({
  wallet,
  refreshTick,
  onRekeyed,
}: {
  wallet: RingsWallet;
  refreshTick?: number;
  /** Absent where no wallet list is behind this card to refresh. */
  onRekeyed?: () => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  // A paused wallet is suppressed alongside an unprovisioned one: the read is
  // refused for an identity that cannot be derived, and this card mounts per
  // wallet on every visit, so asking would fail on a loop.
  const readable = wallet.shieldedAddress !== null && wallet.status !== "paused";
  const { state } = useRingsBalance(readable ? wallet.id : null, refreshTick);

  // Paused is checked first, and having no address does not exempt a wallet from
  // it: a re-key claims the row before it rotates, so a rotation that fails
  // leaves a wallet paused with nothing published yet. Reading that as merely
  // unprovisioned would hide the recovery behind an instruction to provision,
  // which is the one thing a paused wallet refuses.
  if (wallet.status === "paused") {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <p className="text-pretty break-words text-sm text-secondary">
          {t("DashboardHeliusRings.balances.paused")}
        </p>
        {onRekeyed ? <RekeyWalletDialog wallet={wallet} onRekeyed={onRekeyed} /> : null}
      </div>
    );
  }

  if (wallet.shieldedAddress === null) {
    return (
      <p className="text-pretty break-words text-sm text-secondary">
        {t("DashboardHeliusRings.balances.notProvisioned")}
      </p>
    );
  }

  if (state.name === "failed") {
    return (
      <p className="text-pretty break-words text-xs text-error" role="alert">
        {state.message ?? t("DashboardHeliusRings.balances.readFailed")}
      </p>
    );
  }

  if (state.name === "loading") {
    return <p className="text-sm text-secondary">{t("DashboardHeliusRings.balances.unsynced")}</p>;
  }

  const { sync } = state;
  return sync.balances.length === 0 ? (
    <p className="text-sm text-primary">{t("DashboardHeliusRings.balances.empty")}</p>
  ) : (
    <p className="text-sm font-medium tabular-nums text-primary">
      {typeof sync.totalUsd === "number"
        ? formatCurrencyAmount(sync.totalUsd, locale)
        : t("DashboardHeliusRings.overview.unpriced")}
    </p>
  );
}
