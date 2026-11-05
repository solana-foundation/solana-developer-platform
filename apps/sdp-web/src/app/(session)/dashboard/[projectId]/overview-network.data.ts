"use client";

import { networkSnapshotSchema } from "@sdp/types/network-metrics";
import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { homeQueryKeys } from "./home-query-key";
import type { OverviewNetworkProps } from "./overview-network";

// sdp-api reads data.solana.com and caches it; this only reads SDP's route. The whole path:
// docs/architecture/network-figures.md.
const networkResponseSchema = z.object({ data: networkSnapshotSchema });

/** The figures change once a day, but the snapshot carries the cluster's health: with the API
 * serving a reading at most 3 minutes old, refetching every 5 keeps it under the Overview's
 * 10-minute limit. Each refetch reads SDP's cache, never data.solana.com. */
const NETWORK_REFRESH_MS = 5 * 60_000;

/**
 * The network section's state. A kept snapshot stays on screen through a failed refresh: it
 * carries its own day, so the section dates it rather than passing it off as current.
 */
export function useOverviewNetwork(): OverviewNetworkProps {
  const scope = useDashboardKeyScope();
  const { data, error } = useDashboardRead(homeQueryKeys.network(scope), networkResponseSchema, {
    revalidateOnFocus: false,
    refreshInterval: NETWORK_REFRESH_MS,
  });
  if (data) return { status: "ready", snapshot: data.data };
  return error ? { status: "unavailable" } : { status: "loading" };
}
