"use client";

import { useSWRConfig } from "swr";
import { custodyQueryKeys } from "./custody-query-key";

/** Refresh read inventories in the current Dashboard Project's SWR provider. */
export function useWalletInventoryRefresh() {
  const { mutate } = useSWRConfig();
  return () => {
    void mutate(custodyQueryKeys.isWalletInventoryKey, undefined, { revalidate: true });
  };
}
