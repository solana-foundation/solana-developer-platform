import type { CustodyWalletTokenBalance } from "@sdp/types";

export const BALANCE_REFRESH_INTERVAL_MS = 30_000;

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

function getApiError(body: ApiErrorEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
}

export async function fetchWalletBalances(): Promise<Record<string, CustodyWalletTokenBalance[]>> {
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
      .filter(
        (wallet): wallet is { walletId: string; balances: CustodyWalletTokenBalance[] } =>
          Boolean(wallet.walletId) && Array.isArray(wallet.balances)
      )
      .map((wallet) => [wallet.walletId, wallet.balances])
  );
}

export async function fetchWalletBalance(walletId: string): Promise<CustodyWalletTokenBalance[]> {
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
