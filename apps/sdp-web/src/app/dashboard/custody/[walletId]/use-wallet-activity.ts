"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { custodyQueryKeys } from "@/app/dashboard/custody/custody-query-key";
import {
  fetchWalletActivity,
  WALLET_ACTIVITY_LIMIT,
  type WalletActivityPayload,
} from "@/app/dashboard/custody/wallet-activity.data";

/**
 * The wallet's latest `limit` activity rows (payments and issuance, newest first), read again
 * every 20s while the page is open. The default window is shared by the Overview's recent rows
 * and the Activity tab, so switching tabs reads the same cache; each wider window the Activity
 * tab asks for has a key of its own (see `useWalletActivityWindow`). `onSuccess` and `onError`
 * fire only when a read this hook started settles, never for rows that were already cached.
 */
export function useWalletActivity(
  walletId: string,
  limit: number = WALLET_ACTIVITY_LIMIT,
  callbacks: Pick<SWRConfiguration<WalletActivityPayload>, "onSuccess" | "onError"> = {}
) {
  const key =
    limit === WALLET_ACTIVITY_LIMIT
      ? custodyQueryKeys.walletActivity({ walletId })
      : ([...custodyQueryKeys.walletActivity({ walletId }), limit] as const);
  return useSWR(key, () => fetchWalletActivity(walletId, { limit }), {
    refreshInterval: 20_000,
    refreshWhenHidden: false,
    ...callbacks,
  });
}
