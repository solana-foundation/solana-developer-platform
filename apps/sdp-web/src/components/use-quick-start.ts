"use client";

import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  EMPTY_QUICK_START_PREFS,
  isQuickStartComplete,
  type QuickStartPrefs,
  type QuickStartStatus,
  quickStartKey,
  quickStartStatusSchema,
  readQuickStartPrefs,
  resolveQuickStartSteps,
  subscribeQuickStart,
  subscribeQuickStartStatusStale,
} from "@/lib/dashboard-quick-start";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { quickStartQueryKeys } from "./quick-start-query-key";

const STATUS_REFRESH_MS = 120_000;

const quickStartResponseSchema = z.object({ data: quickStartStatusSchema.nullable() });

async function fetchQuickStartStatus(): Promise<QuickStartStatus> {
  const result = await dashboardFetch<unknown>("/api/dashboard/quick-start");
  if (!result.ok) throw new Error(result.error);
  // Unknown keeps the last known status rather than hiding the guide on a transient failure.
  const body = quickStartResponseSchema.parse(result.data);
  if (body.data === null) throw new Error("Quick start status unknown");
  return body.data;
}

/**
 * Who may see the guide: a sandbox key manager inside an organization and project. The server's
 * first read is only a seed: when it failed, the status is read again here, so the guide
 * recovers once the service does.
 */
function useQuickStartEligibility(): boolean {
  const { sdpEnvironment, dashboardAccess, dashboardCacheScope, selectedProjectId } =
    useDashboardWorkspace();
  return Boolean(
    sdpEnvironment === "sandbox" &&
      dashboardAccess.capabilities.canManageApiKeys &&
      dashboardCacheScope.orgId &&
      selectedProjectId
  );
}

/** Every step done for this status; an unknown status is never complete. */
function isGuideComplete(
  status: QuickStartStatus | null | undefined,
  skipped: QuickStartPrefs["skipped"]
): boolean {
  return status ? isQuickStartComplete(resolveQuickStartSteps({ status, skipped })) : false;
}

/**
 * The server's setup status, re-read on focus, on an interval and when a flow marks it stale.
 * The interval stops once the guide is complete: there is nothing left on screen to update.
 */
function useQuickStartStatus(
  live: boolean,
  skipped: QuickStartPrefs["skipped"]
): QuickStartStatus | null {
  const { initialQuickStartStatus } = useDashboardWorkspace();
  const { data: status, mutate: refreshStatus } = usePersistedDashboardSWR(
    live ? quickStartQueryKeys.status() : null,
    fetchQuickStartStatus,
    {
      fallbackData: initialQuickStartStatus ?? undefined,
      revalidateIfStale: false,
      revalidateOnFocus: true,
      // Inline, so the read that completes the guide ends the poll (apps/sdp-web/AGENTS.md). SWR
      // passes only what it fetched, so the server's seed stands in until the first read.
      refreshInterval: (latest) =>
        isGuideComplete(latest ?? initialQuickStartStatus, skipped) ? 0 : STATUS_REFRESH_MS,
    }
  );

  useEffect(() => {
    if (!live) return;
    return subscribeQuickStartStatusStale(() => {
      void refreshStatus();
    });
  }, [live, refreshStatus]);

  return status ?? initialQuickStartStatus;
}

/**
 * The quick start's state, shared by the Overview card, the sidebar card and Settings: who may
 * see it, the resolved steps, and the person's choices. SWR dedupes the status read across the
 * surfaces mounted at once.
 */
export function useQuickStart() {
  const { dashboardCacheScope } = useDashboardWorkspace();
  const storageKey = quickStartKey(dashboardCacheScope);
  const prefs = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStartPrefs(storageKey),
    () => EMPTY_QUICK_START_PREFS
  );
  const eligible = useQuickStartEligibility();
  const live = eligible && !prefs.dismissed;
  const knownStatus = useQuickStartStatus(live, prefs.skipped);

  const steps = knownStatus
    ? resolveQuickStartSteps({ status: knownStatus, skipped: prefs.skipped })
    : [];
  const complete = steps.length > 0 && isQuickStartComplete(steps);

  return {
    storageKey,
    eligible,
    /** Eligible, not dismissed and not yet complete: the cards render. */
    visible: live && knownStatus !== null && !complete,
    complete,
    prefs,
    status: knownStatus,
    steps,
  };
}
