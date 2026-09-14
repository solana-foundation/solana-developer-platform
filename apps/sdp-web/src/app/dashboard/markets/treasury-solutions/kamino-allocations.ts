"use client";

import useSWR from "swr";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  type KaminoVaultAllocations,
  kaminoVaultAllocationsSchema,
} from "./kamino-allocations-schema";

/**
 * One Kamino vault's allocations, read through the dashboard BFF
 * (`/api/dashboard/markets/earn/kamino-allocations`) so the browser never
 * touches api.kamino.finance. The BFF caches upstream for 45s and SWR keeps
 * the served cell fresh at its own slower cadence; a failed read surfaces as
 * `error` and the cell degrades to the shared placeholder.
 *
 * `undefined` vault (a non-Kamino row) issues no request at all: the SWR key
 * is null, so the strategies table costs nothing for providers this column
 * cannot describe.
 */
const ALLOCATIONS_REFRESH_MS = 60_000;

export function useKaminoVaultAllocations(vaultAddress: string | undefined) {
  const { data, error, isLoading } = useSWR(
    vaultAddress ? ["dashboard-earn-kamino-allocations", vaultAddress] : null,
    async (): Promise<KaminoVaultAllocations> => {
      const result = await dashboardFetch<KaminoVaultAllocations>(
        `/api/dashboard/markets/earn/kamino-allocations?vault=${encodeURIComponent(vaultAddress ?? "")}`
      );
      if (!result.ok) throw new Error(result.error);
      // Re-parsed with the same schema the route parsed upstream: the client
      // trusts nothing about a response it did not shape.
      return kaminoVaultAllocationsSchema.parse(result.data);
    },
    { refreshInterval: ALLOCATIONS_REFRESH_MS, shouldRetryOnError: false }
  );
  return { allocations: data, error, isLoading };
}
