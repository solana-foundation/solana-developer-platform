"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import useSWR from "swr";
import { formatCurrencyAmount, resolveTotalBalance } from "../payments/payments-overview.utils";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;

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
  const { data } = useSWR<CustodyWalletTokenBalance[]>(
    walletId ? `wallet-card-balance:${walletId}` : null,
    () => fetchWalletBalances(walletId),
    {
      fallbackData: initialBalances,
      revalidateOnFocus: true,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    }
  );

  const totalBalance = resolveTotalBalance(data ?? initialBalances);

  return <span className="font-medium text-[#1c1c1d]">{formatCurrencyAmount(totalBalance)}</span>;
}
