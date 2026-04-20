"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatCurrencyAmount, resolveTotalBalance } from "../payments/payments-overview.utils";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;
const WALLET_BALANCE_CACHE_TTL_MS = 30_000;

interface WalletBalancesEnvelope {
  data?: {
    walletBalances?: {
      balances?: CustodyWalletTokenBalance[];
    };
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

async function fetchWalletBalances(walletId: string): Promise<CustodyWalletTokenBalance[]> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletBalancesEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet balances request failed (${response.status}).`));
  }

  return Array.isArray(body.data?.walletBalances?.balances)
    ? body.data.walletBalances.balances
    : [];
}

export function WalletCardBalanceValue({ walletId, initialBalances }: WalletCardBalanceValueProps) {
  const { data, error } = usePersistedDashboardSWR<CustodyWalletTokenBalance[]>(
    walletId ? `wallet-card-balance:${walletId}` : null,
    () => fetchWalletBalances(walletId),
    {
      fallbackData: initialBalances,
      revalidateOnFocus: true,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    },
    {
      key: `wallet-card-balance.${walletId}`,
      ttlMs: WALLET_BALANCE_CACHE_TTL_MS,
    }
  );

  const totalBalance = resolveTotalBalance(data ?? initialBalances);

  return (
    <span className={`font-medium ${error ? "text-[rgba(28,28,29,0.4)]" : "text-[#1c1c1d]"}`}>
      {formatCurrencyAmount(totalBalance)}
      {error ? <span className="sr-only"> (stale)</span> : null}
    </span>
  );
}
