"use client";

import useSWR from "swr";
import { custodyQueryKeys } from "@/app/dashboard/custody/custody-query-key";
import { fetchWalletActivity } from "@/app/dashboard/custody/wallet-activity.data";

/**
 * The wallet's latest activity (payments and issuance, newest first), read again every 20s
 * while the page is open. Shared by the Overview's recent rows and the Activity tab, so
 * switching tabs reads the same cache.
 */
export function useWalletActivity(walletId: string) {
  return useSWR(
    custodyQueryKeys.walletActivity({ walletId }),
    () => fetchWalletActivity(walletId),
    {
      refreshInterval: 20_000,
      refreshWhenHidden: false,
    }
  );
}
