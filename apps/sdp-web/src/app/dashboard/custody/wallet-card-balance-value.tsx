"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatCurrencyAmount, resolveTotalBalance } from "../payments/payments-overview.utils";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;
const WALLET_BALANCE_CACHE_TTL_MS = 30_000;

interface ApiErrorEnvelope {
  error?: {
    message?: string;
  };
}

interface WalletBalancesEnvelope extends ApiErrorEnvelope {
  data?: {
    wallets?: Array<{
      walletId?: string;
      balances?: CustodyWalletTokenBalance[];
    }>;
  };
}

interface WalletBalanceEnvelope extends ApiErrorEnvelope {
  data?:
    | {
        walletBalances?: {
          balances?: CustodyWalletTokenBalance[];
        };
      }
    | {
        balances?: CustodyWalletTokenBalance[];
      };
}

interface WalletCardBalanceValueProps {
  walletId: string;
  initialBalances: CustodyWalletTokenBalance[];
}

function getApiError(body: ApiErrorEnvelope, fallback: string): string {
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

  if (!Array.isArray(body.data?.wallets)) {
    throw new Error("Wallet balances response did not include wallets.");
  }

  return Object.fromEntries(
    body.data.wallets
      .filter((wallet): wallet is { walletId: string; balances?: CustodyWalletTokenBalance[] } =>
        Boolean(wallet.walletId)
      )
      .map((wallet) => [wallet.walletId, wallet.balances ?? []])
  );
}

async function fetchWalletBalance(walletId: string): Promise<CustodyWalletTokenBalance[]> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletBalanceEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet balance request failed (${response.status}).`));
  }

  let balances: CustodyWalletTokenBalance[] | undefined;
  if (body.data && "walletBalances" in body.data) {
    balances = body.data.walletBalances?.balances;
  } else if (body.data && "balances" in body.data) {
    balances = body.data.balances;
  }
  if (!Array.isArray(balances)) {
    throw new Error("Wallet balance response did not include balances.");
  }

  return balances;
}

export function WalletCardBalanceValue({ walletId, initialBalances }: WalletCardBalanceValueProps) {
  const t = useTranslations();
  const { data: batchBalances, error: batchError } = usePersistedDashboardSWR<
    Record<string, CustodyWalletTokenBalance[]>
  >(
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
  const batchFailed = Boolean(batchError);
  const { data: fallbackBalances, error: fallbackError } = usePersistedDashboardSWR<
    CustodyWalletTokenBalance[]
  >(
    batchFailed && walletId ? `wallet-card-balance-fallback:${walletId}` : null,
    () => fetchWalletBalance(walletId),
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    },
    {
      key: `wallet-card-balance-fallback.${walletId}`,
      ttlMs: WALLET_BALANCE_CACHE_TTL_MS,
    }
  );

  const balances = batchFailed
    ? (fallbackBalances ?? batchBalances?.[walletId] ?? initialBalances)
    : (batchBalances?.[walletId] ?? initialBalances);
  const hasError = batchFailed && (fallbackBalances === undefined || Boolean(fallbackError));
  const totalBalance = resolveTotalBalance(balances);

  return (
    <span className={`font-medium ${hasError ? "text-muted" : "text-primary"}`}>
      {formatCurrencyAmount(totalBalance)}
      {hasError ? <span className="sr-only"> {t("DashboardCustody.stale")}</span> : null}
    </span>
  );
}
