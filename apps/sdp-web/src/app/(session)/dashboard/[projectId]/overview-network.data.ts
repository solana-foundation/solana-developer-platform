"use client";

import { type NetworkSnapshot, networkSnapshotSchema } from "@sdp/types/network-metrics";
import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { homeQueryKeys } from "./home-query-key";
import type { OverviewNetworkProps } from "./overview-network";

// sdp-api reads data.solana.com and caches it; this only reads SDP's route. The whole path:
// docs/architecture/network-figures.md.
const networkResponseSchema = z.object({ data: networkSnapshotSchema });

/** The figures change once a day, but the snapshot carries the cluster's health: with the API
 * serving a reading at most 3 minutes old, refetching every 5 keeps it under the Overview's
 * 10-minute limit. Each refetch reads SDP's cache, never data.solana.com. */
const NETWORK_REFRESH_MS = 5 * 60_000;
const NETWORK_SNAPSHOT_TTL_MS = 60 * 60_000;
/** The saved snapshot's shape: bump it with any change to networkSnapshotSchema, so a browser
 * holding the old shape drops it instead of drawing it. */
const NETWORK_SNAPSHOT_VERSION = 3;

/** The Overview's network figures. Parsed, not cast: a malformed body is an error, never "no data". */
export async function fetchNetworkSnapshot(): Promise<NetworkSnapshot> {
  const response = await dashboardRequest("/api/dashboard/network", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Network figures request failed (${response.status})`);
  }
  return networkResponseSchema.parse(await response.json()).data;
}

/**
 * The network section's state. A kept snapshot stays on screen through a failed refresh: it
 * carries its own day, so the section dates it rather than passing it off as current.
 */
export function useOverviewNetwork(): OverviewNetworkProps {
  const { data, error } = usePersistedDashboardSWR(
    homeQueryKeys.network(),
    fetchNetworkSnapshot,
    { revalidateOnFocus: false, refreshInterval: NETWORK_REFRESH_MS },
    { key: "home-network", ttlMs: NETWORK_SNAPSHOT_TTL_MS, version: NETWORK_SNAPSHOT_VERSION }
  );
  if (data) return { status: "ready", snapshot: data };
  return error ? { status: "unavailable" } : { status: "loading" };
}
