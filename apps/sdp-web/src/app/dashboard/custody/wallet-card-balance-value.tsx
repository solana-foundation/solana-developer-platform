"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatCurrencyAmount, resolveTotalBalance } from "../payments/payments-overview.utils";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;
const WALLET_BALANCE_CACHE_TTL_MS = 30_000;

interface WalletBalancesEnvelope {
  data?: {
    wallets?: Array<{
      walletId?: string;
      balances?: CustodyWalletTokenBalance[];
    }>;
  };
  error?: {
    message?: string;
  };
}

interface WalletCardBalanceValueProps {
  walletId: string;
  initialBalances: CustodyWalletTokenBalance[];
}

function getApiError(body: WalletBalancesEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
}

async function fetchWalletBalances(): Promise<Record<string, CustodyWalletTokenBalance[]>> {
  const response = await fetch("/api/dashboard/wallets?includeBalances=true&view=summary", {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as WalletBalancesEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet balances request failed (${response.status}).`));
  }

  return Object.fromEntries(
    (body.data?.wallets ?? [])
      .filter((wallet): wallet is { walletId: string; balances?: CustodyWalletTokenBalance[] } =>
        Boolean(wallet.walletId)
      )
      .map((wallet) => [wallet.walletId, wallet.balances ?? []])
  );
}

export function WalletCardBalanceValue({ walletId, initialBalances }: WalletCardBalanceValueProps) {
  const t = useTranslations();
  const { data, error } = usePersistedDashboardSWR<Record<string, CustodyWalletTokenBalance[]>>(
    walletId ? "wallet-card-balances" : null,
    fetchWalletBalances,
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    },
    {
      key: "wallet-card-balances",
      ttlMs: WALLET_BALANCE_CACHE_TTL_MS,
    }
  );

  const totalBalance = resolveTotalBalance(data?.[walletId] ?? initialBalances);

  return (
    <span className={`font-medium ${error ? "text-muted" : "text-primary"}`}>
      {formatCurrencyAmount(totalBalance)}
      {error ? <span className="sr-only"> {t("DashboardCustody.stale")}</span> : null}
    </span>
  );
}
