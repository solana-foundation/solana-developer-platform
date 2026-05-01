"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { DASHBOARD_WARM_SNAPSHOT_KEY } from "@/lib/dashboard-warm-snapshot";
import { fetchDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";

interface DashboardWarmSnapshotPreloaderProps {
  orgId: string | null;
  userId: string | null;
}

export function DashboardWarmSnapshotPreloader({
  orgId,
  userId,
}: DashboardWarmSnapshotPreloaderProps) {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    if (!orgId || !userId) {
      return;
    }

    let cancelled = false;

    const preloadSnapshot = async () => {
      try {
        const snapshot = await fetchDashboardWarmSnapshot();
        if (!cancelled) {
          await mutate(DASHBOARD_WARM_SNAPSHOT_KEY, snapshot, { revalidate: false });
        }
      } catch {
        // Snapshot preloading is opportunistic; route-level hooks surface errors where useful.
      }
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(() => {
        void preloadSnapshot();
      });

      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    const timeoutId = globalThis.setTimeout(() => {
      void preloadSnapshot();
    }, 300);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [mutate, orgId, userId]);

  return null;
}
