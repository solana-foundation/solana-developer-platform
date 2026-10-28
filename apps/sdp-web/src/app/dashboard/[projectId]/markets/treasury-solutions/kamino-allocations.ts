"use client";

import type { EarnStrategy } from "@sdp/types/earn";
import useSWR from "swr";
import { earnQueryKeys } from "@/app/dashboard/[projectId]/markets/earn/earn-query-key";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  KAMINO_ALLOCATIONS_MAX_VAULTS,
  type KaminoVaultAllocationsBatch,
  kaminoVaultAllocationsBatchSchema,
} from "./kamino-allocations-schema";

/**
 * Allocations for every Kamino vault the strategies table shows, in ONE read
 * through the dashboard BFF (`/api/dashboard/markets/earn/kamino-allocations`)
 * so the browser never touches api.kamino.finance and never issues one request
 * per row. The BFF fans the batch out to its 45s per-vault cache and SWR keeps
 * the column fresh at its own slower cadence. A failed refresh surfaces as
 * `error` but keeps the last good read, which the rows go on showing; a vault
 * no read has answered shows no allocations.
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
 * One BFF read of at most `KAMINO_ALLOCATIONS_MAX_VAULTS` vaults. The request
 * states its cluster explicitly for the BFF's mainnet-only gate, and the store
 * behind it independently refuses a value that is not a public key or that the
 * strategy catalogue does not front (each vault is interpolated into an
 * upstream URL).
 */
async function readKaminoAllocationsBatch(
  vaults: readonly string[]
): Promise<KaminoVaultAllocationsBatch["vaults"]> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/markets/earn/kamino-allocations?vaults=${vaults
      .map(encodeURIComponent)
      .join(",")}&cluster=mainnet-beta`
  );
  if (!result.ok) throw new Error(result.error);
  // Re-parsed with the same schema module the route parsed upstream with: the
  // client trusts nothing about a response it did not shape.
  return kaminoVaultAllocationsBatchSchema.parse(result.data).vaults;
}

/**
 * One read for `vaults` (from `kaminoAllocationsVaults`), split into BFF reads
 * of at most `KAMINO_ALLOCATIONS_MAX_VAULTS` and merged, so a catalogue past one
 * page still fills every cell; an empty list issues no request.
 *
 * @param vaults - The vaults to read, already deduplicated and sorted.
 * @returns The parsed reads keyed by vault, the read's error, and its loading state.
 */
export function useKaminoVaultAllocations(vaults: readonly string[]) {
  const { data, error, isLoading } = useSWR<KaminoVaultAllocationsBatch["vaults"], Error>(
    vaults.length > 0 ? earnQueryKeys.kaminoAllocations({ vaults: vaults.join(",") }) : null,
    async () => {
      const batches: string[][] = [];
      for (let start = 0; start < vaults.length; start += KAMINO_ALLOCATIONS_MAX_VAULTS) {
        batches.push(vaults.slice(start, start + KAMINO_ALLOCATIONS_MAX_VAULTS));
      }
      const reads = await Promise.all(batches.map(readKaminoAllocationsBatch));
      return Object.fromEntries(reads.flatMap((read) => Object.entries(read)));
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
