import type { CustodyWalletTokenBalance } from "@sdp/types";
import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import {
  getWalletBalanceApiError,
  parseWalletBalanceResponse,
  walletTokenBalanceSchema,
} from "@/lib/wallet-balance-response";

export const BALANCE_REFRESH_INTERVAL_MS = 30_000;

const walletBalanceListRowSchema = z.object({
  id: z.string().min(1),
  balances: z.array(walletTokenBalanceSchema),
});
const walletBalanceListResponseSchema = z.object({
  data: z.object({
    wallets: z.array(z.unknown()).transform((rows) =>
      rows.flatMap((row) => {
        const parsed = walletBalanceListRowSchema.safeParse(row);
        // Omit unavailable or invalid rows so successful wallets stay usable and missing ones retry.
        return parsed.success ? [parsed.data] : [];
      })
    ),
  }),
});

export async function fetchWalletBalances(): Promise<Record<string, CustodyWalletTokenBalance[]>> {
  const response = await dashboardRequest(
    "/api/dashboard/wallets?includeBalances=true&view=summary",
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(
      getWalletBalanceApiError(body, `Wallet balances request failed (${response.status}).`)
    );
  }

  const parsed = walletBalanceListResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Wallet balances response did not include wallets.");
  }

  return Object.fromEntries(parsed.data.data.wallets.map((wallet) => [wallet.id, wallet.balances]));
}

export async function fetchWalletBalance(walletId: string): Promise<CustodyWalletTokenBalance[]> {
  const response = await dashboardRequest(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(
      getWalletBalanceApiError(body, `Wallet balance request failed (${response.status}).`)
    );
  }

  return parseWalletBalanceResponse(body, walletId).balances;
}
