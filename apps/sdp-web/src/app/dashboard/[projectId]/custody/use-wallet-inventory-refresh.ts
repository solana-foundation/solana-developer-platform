"use client";

import { useSWRConfig } from "swr";
import { issuanceQueryKeys } from "@/app/dashboard/[projectId]/issuance/issuance-query-key";
import { earnQueryKeys } from "@/app/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";

/** Refresh read inventories in the current Dashboard Project's SWR provider. */
export function useWalletInventoryRefresh() {
  const { mutate } = useSWRConfig();
  return () => {
    void mutate(
      (key) =>
        key === paymentsQueryKeys.actionWallets() ||
        key === earnQueryKeys.fundingWallets() ||
        issuanceQueryKeys.isWalletInventoryKey(key),
      undefined,
      { revalidate: true }
    );
  };
}
