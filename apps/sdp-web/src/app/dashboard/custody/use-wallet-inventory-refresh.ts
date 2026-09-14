"use client";

import { useSWRConfig } from "swr";
import { earnQueryKeys } from "@/app/dashboard/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";

/** Refresh read inventories in the current Dashboard Project's SWR provider. */
export function useWalletInventoryRefresh() {
  const { mutate } = useSWRConfig();
  return () => {
    void mutate(
      (key) =>
        key === paymentsQueryKeys.actionWallets() ||
        key === earnQueryKeys.fundingWallets() ||
        (Array.isArray(key) &&
          (key[0] === "token-management-authority-wallets" ||
            key[0] === "token-management-supporting-data")),
      undefined,
      { revalidate: true }
    );
  };
}
