"use client";

import type { SWRConfiguration } from "swr";

export const DASHBOARD_SWR_CONFIG: SWRConfiguration = {
  dedupingInterval: 10_000,
  errorRetryCount: 2,
  focusThrottleInterval: 15_000,
  keepPreviousData: true,
  revalidateIfStale: true,
  revalidateOnFocus: true,
};
