"use client";

import type { EarnStrategy } from "@sdp/types/earn";
import useSWR from "swr";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  type KaminoVaultAllocationsBatch,
  kaminoVaultAllocationsBatchSchema,
} from "./kamino-allocations-schema";

/**
 * Allocations for every Kamino vault the strategies table shows, in ONE read
 * through the dashboard BFF (`/api/dashboard/markets/earn/kamino-allocations`)
 * so the browser never touches api.kamino.finance and never issues one request
 * per row. The BFF fans the batch out to its 45s per-vault cache and SWR keeps
 * the column fresh at its own slower cadence; a vault the batch could not read
 * is absent and its cell degrades to the shared placeholder.
 *
 * Allocation weights move with the vault's rebalancing, not with focus, so a
 * focus event does not refetch them. A failed batch retries at the poll's own
 * pace: SWR pauses the poll while the key holds an error, and focus no longer
 * clears it.
 */
const ALLOCATIONS_REFRESH_MS = 60_000;

/**
 * The vault a strategy row's Information cell describes, or `undefined` when
 * the allocations source cannot describe it: Kamino's kvaults REST source is
 * mainnet-only, so a devnet Kamino row is an UNSUPPORTED read exactly like a
 * non-Kamino one, and costs no network at all.
 */
export function kaminoAllocationsVault(
  strategy: Pick<EarnStrategy, "provider" | "providerReference" | "hostCluster">
): string | undefined {
  return strategy.provider === "kamino" && strategy.hostCluster === "mainnet-beta"
    ? strategy.providerReference
    : undefined;
}

/**
 * Every vault a set of rows can describe, deduplicated and sorted so the read's
 * key follows the catalogue, never the table's sort order.
 */
export function kaminoAllocationsVaults(
  strategies: readonly Pick<EarnStrategy, "provider" | "providerReference" | "hostCluster">[]
): string[] {
  const vaults = new Set<string>();
  for (const strategy of strategies) {
    const vault = kaminoAllocationsVault(strategy);
    if (vault !== undefined) vaults.add(vault);
  }
  return [...vaults].sort();
}

/**
 * One read for `vaults` (from `kaminoAllocationsVaults`); an empty list issues
 * no request. The request states its cluster explicitly for the BFF's
 * mainnet-only gate, and the store behind it independently refuses a value
 * that is not a public key or that the strategy catalogue does not front (each
 * vault is interpolated into an upstream URL).
 *
 * @param vaults - The vaults to read, already deduplicated and sorted.
 * @returns The parsed reads keyed by vault, the batch's error, and its loading state.
 */
export function useKaminoVaultAllocations(vaults: readonly string[]) {
  const query = vaults.map(encodeURIComponent).join(",");
  const { data, error, isLoading } = useSWR<KaminoVaultAllocationsBatch["vaults"], Error>(
    vaults.length > 0 ? ["dashboard-earn-kamino-allocations", query] : null,
    async () => {
      const result = await dashboardFetch<unknown>(
        `/api/dashboard/markets/earn/kamino-allocations?vaults=${query}&cluster=mainnet-beta`
      );
      if (!result.ok) throw new Error(result.error);
      // Re-parsed with the same schema module the route parsed upstream with:
      // the client trusts nothing about a response it did not shape.
      return kaminoVaultAllocationsBatchSchema.parse(result.data).vaults;
    },
    {
      refreshInterval: ALLOCATIONS_REFRESH_MS,
      revalidateOnFocus: false,
      errorRetryInterval: ALLOCATIONS_REFRESH_MS,
    }
  );
  return { allocationsByVault: data, error, isLoading };
}

/** The table-wide read the Information cells take their vault's figures from. */
export type KaminoVaultAllocationsRead = ReturnType<typeof useKaminoVaultAllocations>;
