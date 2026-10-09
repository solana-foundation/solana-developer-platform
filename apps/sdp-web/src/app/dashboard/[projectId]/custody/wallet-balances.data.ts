import type { CustodyWalletTokenBalance } from "@sdp/types";
import { dashboardRequest } from "@/lib/dashboard-fetch";

export const BALANCE_REFRESH_INTERVAL_MS = 30_000;

interface ApiErrorEnvelope {
  error?: {
    message?: string;
  };
}

interface WalletBalancesEnvelope extends ApiErrorEnvelope {
  data?: {
    wallets?: Array<{
      id?: string;
      balances?: CustodyWalletTokenBalance[];
    }>;
  };
}

interface WalletBalanceEnvelope extends ApiErrorEnvelope {
  data?:
    | {
        walletBalances?: {
          custodyWalletId?: string;
          balances?: CustodyWalletTokenBalance[];
        };
      }
    | {
        custodyWalletId?: string;
        balances?: CustodyWalletTokenBalance[];
      };
}

function getApiError(body: ApiErrorEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
}

export async function fetchWalletBalances(): Promise<Record<string, CustodyWalletTokenBalance[]>> {
  const response = await dashboardRequest(
    "/api/dashboard/wallets?includeBalances=true&view=summary",
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletBalancesEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet balances request failed (${response.status}).`));
  }

  if (!Array.isArray(body.data?.wallets)) {
    throw new Error("Wallet balances response did not include wallets.");
  }

  return Object.fromEntries(
    body.data.wallets
      .filter(
        (wallet): wallet is { id: string; balances: CustodyWalletTokenBalance[] } =>
          Boolean(wallet.id) && Array.isArray(wallet.balances)
      )
      .map((wallet) => [wallet.id, wallet.balances])
  );
}

export async function fetchWalletBalance(walletId: string): Promise<CustodyWalletTokenBalance[]> {
  const response = await dashboardRequest(
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
  let custodyWalletId: string | undefined;
  if (body.data && "walletBalances" in body.data) {
    balances = body.data.walletBalances?.balances;
    custodyWalletId = body.data.walletBalances?.custodyWalletId;
  } else if (body.data && "balances" in body.data) {
    balances = body.data.balances;
    custodyWalletId = body.data.custodyWalletId;
  }
  if (!Array.isArray(balances) || custodyWalletId !== walletId) {
    throw new Error("Wallet balance response did not include balances.");
  }

  return balances;
}
