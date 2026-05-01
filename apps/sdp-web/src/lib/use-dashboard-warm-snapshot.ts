"use client";

import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  DASHBOARD_WARM_SNAPSHOT_KEY,
  DASHBOARD_WARM_SNAPSHOT_REFRESH_MS,
  DASHBOARD_WARM_SNAPSHOT_ROUTE,
  DASHBOARD_WARM_SNAPSHOT_STALE_MS,
  type DashboardWarmSnapshot,
} from "@/lib/dashboard-warm-snapshot";

interface DashboardWarmSnapshotEnvelope {
  data?: {
    snapshot?: DashboardWarmSnapshot;
  };
  error?: {
    message?: string;
  };
}

interface UseDashboardWarmSnapshotOptions {
  fallbackData?: DashboardWarmSnapshot;
  revalidate?: boolean;
}

function getApiError(body: DashboardWarmSnapshotEnvelope, fallback: string): string {
  if (body.error?.message) {
    return body.error.message;
  }

  return fallback;
}

export async function fetchDashboardWarmSnapshot(): Promise<DashboardWarmSnapshot> {
  const response = await fetch(DASHBOARD_WARM_SNAPSHOT_ROUTE, {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as DashboardWarmSnapshotEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Dashboard snapshot request failed (${response.status}).`));
  }

  if (!body.data?.snapshot) {
    throw new Error("Dashboard snapshot response is missing snapshot details.");
  }

  return body.data.snapshot;
}

export function useDashboardWarmSnapshot({
  fallbackData,
  revalidate = true,
}: UseDashboardWarmSnapshotOptions = {}) {
  return usePersistedDashboardSWR<DashboardWarmSnapshot>(
    DASHBOARD_WARM_SNAPSHOT_KEY,
    revalidate ? () => fetchDashboardWarmSnapshot() : null,
    {
      dedupingInterval: 10_000,
      fallbackData,
      refreshInterval: revalidate ? DASHBOARD_WARM_SNAPSHOT_REFRESH_MS : 0,
      revalidateOnFocus: revalidate,
    },
    {
      key: "warm-snapshot",
      ttlMs: DASHBOARD_WARM_SNAPSHOT_STALE_MS,
    }
  );
}
