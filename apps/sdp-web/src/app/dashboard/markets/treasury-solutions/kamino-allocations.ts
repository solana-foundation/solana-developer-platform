"use client";

import type { SolanaCluster } from "@sdp/types";
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
 * Kamino's allocations source is mainnet-only, so a vault on any other
 * cluster is an UNSUPPORTED read, not a failing one: the SWR key stays null,
 * the same way a non-Kamino row's does, and the cell shows the placeholder.
 * This client-side gate keeps an unsupported row from costing any network at
 * all, and the request states its cluster explicitly so the BFF's own
 * mainnet-only refusal (a 400 for any other cluster) never fires for a row
 * this hook would not have issued anyway. The route's store is the server
 * boundary that independently refuses a value that is not a public key or
 * that the strategy catalogue does not front (the vault is interpolated
 * into the upstream URL).
 *
 * `undefined` vault (a non-Kamino row) issues no request at all: the SWR key
 * is null, so the strategies table costs nothing for providers this column
 * cannot describe.
 */
const ALLOCATIONS_REFRESH_MS = 60_000;

export function useKaminoVaultAllocations(
  vaultAddress: string | undefined,
  cluster: SolanaCluster | undefined
) {
  const { data, error, isLoading } = useSWR(
    vaultAddress && cluster === "mainnet-beta"
      ? ["dashboard-earn-kamino-allocations", vaultAddress]
      : null,
    async (): Promise<KaminoVaultAllocations> => {
      const result = await dashboardFetch<KaminoVaultAllocations>(
        `/api/dashboard/markets/earn/kamino-allocations?vault=${encodeURIComponent(
          vaultAddress ?? ""
        )}&cluster=mainnet-beta`
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
