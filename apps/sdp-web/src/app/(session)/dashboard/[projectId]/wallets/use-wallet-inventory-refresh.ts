"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import { custodyQueryKeys } from "./custody-query-key";

/**
 * After a wallet write: every wallet read refetches in place if it is on screen and is cleared if
 * it is not, and the inventories other features still key by label refetch.
 */
export function useWalletInventoryRefresh() {
  const { mutate } = useSWRConfig();
  const invalidate = useInvalidateDashboardReads();
  return useCallback(() => {
    void invalidate(custodyQueryKeys.isWalletReadKey);
    void mutate(custodyQueryKeys.isWalletLabelKey, undefined, { revalidate: true });
  }, [invalidate, mutate]);
}
