"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import {
  EMPTY_QUICK_START_PREFS,
  isQuickStartComplete,
  type QuickStartStatus,
  quickStartKey,
  type RpcProbeResult,
  readQuickStartPrefs,
  resolveQuickStartSteps,
  subscribeQuickStart,
  subscribeQuickStartStatusStale,
} from "@/lib/dashboard-quick-start";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";

const STATUS_KEY = "dashboard-quick-start-status";
const STATUS_REFRESH_MS = 120_000;
const PROBE_KEY = "dashboard-quick-start-rpc-probe";
// The test route charges the organization's metered RPC pool, so one answer serves every
// surface and every page load for five minutes.
const PROBE_TTL_MS = 5 * 60_000;

async function fetchQuickStartStatus(): Promise<QuickStartStatus> {
  const result = await dashboardFetch<{ data: QuickStartStatus | null }>(
    "/api/dashboard/quick-start"
  );
  // Unknown keeps the last known status rather than hiding the guide on a transient failure.
  if (!result.ok || result.data.data === null) {
    throw new Error(result.ok ? "Quick start status unknown" : result.error);
  }
  return result.data.data;
}

async function probeRpc(): Promise<RpcProbeResult> {
  const checkedAt = new Date().toISOString();
  const result = await dashboardFetch<{
    data: { provider: { id: string }; upstream: { ok: boolean; status: number } };
  }>("/api/dashboard/settings/rpc-test", {
    method: "POST",
    body: { jsonrpc: "2.0", id: "quick-start-probe", method: "getVersion", params: [] },
  });
  if (!result.ok) return { outcome: "unreachable", status: null, provider: null, checkedAt };
  const { provider, upstream } = result.data.data;
  return {
    outcome: upstream.ok ? "ok" : "upstream_error",
    status: upstream.status,
    provider: provider.id,
    checkedAt,
  };
}

const subscribeNothing = () => () => {};

/**
 * The quick start's state, shared by the Overview card, the sidebar card and Settings: who may
 * see it, the three resolved steps, and the person's choices. SWR dedupes the status read and
 * the probe across the surfaces mounted at once.
 */
export function useQuickStart() {
  const {
    initialQuickStartStatus,
    sdpEnvironment,
    dashboardAccess,
    dashboardCacheScope,
    selectedProjectId,
  } = useDashboardWorkspace();
  const storageKey = quickStartKey(dashboardCacheScope);
  const prefs = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStartPrefs(storageKey),
    () => EMPTY_QUICK_START_PREFS
  );
  // The probe answer lives in browser storage, so the server and the first client render both
  // read "checking"; the stored answer arrives on the next render instead of mismatching.
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
  const eligible = Boolean(
    initialQuickStartStatus &&
      sdpEnvironment === "sandbox" &&
      dashboardAccess.capabilities.canManageApiKeys &&
      dashboardCacheScope.orgId &&
      selectedProjectId
  );
  const live = eligible && !prefs.dismissed;

  const { data: status, mutate: refreshStatus } = usePersistedDashboardSWR(
    live ? STATUS_KEY : null,
    fetchQuickStartStatus,
    {
      fallbackData: initialQuickStartStatus ?? undefined,
      revalidateIfStale: false,
      revalidateOnFocus: true,
      refreshInterval: STATUS_REFRESH_MS,
    }
  );
  const { data: probe } = usePersistedDashboardSWR(
    live ? PROBE_KEY : null,
    probeRpc,
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: PROBE_TTL_MS,
      refreshInterval: PROBE_TTL_MS,
    },
    { key: "quick-start-rpc-probe", ttlMs: PROBE_TTL_MS }
  );

  useEffect(() => {
    if (!live) return;
    return subscribeQuickStartStatusStale(() => {
      void refreshStatus();
    });
  }, [live, refreshStatus]);

  const knownStatus = status ?? initialQuickStartStatus;
  const settledProbe = hydrated ? (probe ?? null) : null;
  const steps = knownStatus
    ? resolveQuickStartSteps({ status: knownStatus, probe: settledProbe, skipped: prefs.skipped })
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
    probe: settledProbe,
    steps,
  };
}
