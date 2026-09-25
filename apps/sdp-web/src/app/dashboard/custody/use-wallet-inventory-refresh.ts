"use client";

import { useSWRConfig } from "swr";
import { issuanceQueryKeys } from "@/app/dashboard/issuance/issuance-query-key";
import { isFundingWalletsKey } from "@/app/dashboard/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";

/** Refresh read inventories in the current Dashboard Project's SWR provider. */
export function useWalletInventoryRefresh() {
  const { mutate } = useSWRConfig();
  return () => {
    void mutate(
      (key) =>
        key === paymentsQueryKeys.actionWallets() ||
        isFundingWalletsKey(key) ||
        issuanceQueryKeys.isWalletInventoryKey(key),
      undefined,
      { revalidate: true }
    );
  };
}
