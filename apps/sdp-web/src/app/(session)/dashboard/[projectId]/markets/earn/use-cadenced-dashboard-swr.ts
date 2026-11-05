"use client";

import { useState } from "react";
import type { SWRConfiguration, SWRResponse } from "swr";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { type DashboardReadError, useDashboardSWR } from "@/lib/dashboard-swr";

/**
 * `useCadencedSWR` (`@/lib/use-cadenced-swr`) over `useDashboardSWR`, so a cadenced read is counted
 * as on screen and an invalidation refetches it in place instead of clearing it. SWR restarts a
 * poll only when `refreshInterval` changes; the interval a read implies is stored during render
 * (React's previous-value pattern), so only a cadence change restarts the timer.
 */
export function useCadencedDashboardSWR<Data>(
  key: DashboardRequestKey | null,
  fetcher: (requestKey: DashboardRequestKey) => Promise<Data>,
  cadence: (data: Data | undefined) => number,
  config: Omit<SWRConfiguration<Data, DashboardReadError>, "refreshInterval">
): SWRResponse<Data, DashboardReadError> {
  const [refreshInterval, setRefreshInterval] = useState(() => cadence(undefined));
  const response = useDashboardSWR(key, fetcher, { ...config, refreshInterval });
  const next = cadence(response.data);
  if (next !== refreshInterval) setRefreshInterval(next);
  return response;
}
