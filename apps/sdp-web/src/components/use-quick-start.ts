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
} from "@/lib/dashboard-quick-start.redesign";
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

/** Who may see the guide: a sandbox key manager inside an organization and project. */
function useQuickStartEligibility(): boolean {
  const {
    initialQuickStartStatus,
    sdpEnvironment,
    dashboardAccess,
    dashboardCacheScope,
    selectedProjectId,
  } = useDashboardWorkspace();
  return Boolean(
    initialQuickStartStatus &&
      sdpEnvironment === "sandbox" &&
      dashboardAccess.capabilities.canManageApiKeys &&
      dashboardCacheScope.orgId &&
      selectedProjectId
  );
}

/** The server's setup status, re-read on focus, on an interval and when a flow marks it stale. */
function useQuickStartStatus(live: boolean): QuickStartStatus | null {
  const { initialQuickStartStatus } = useDashboardWorkspace();
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

  useEffect(() => {
    if (!live) return;
    return subscribeQuickStartStatusStale(() => {
      void refreshStatus();
    });
  }, [live, refreshStatus]);

  return status ?? initialQuickStartStatus;
}

/**
 * The latest RPC probe, or null until one answers. A probe answers for the provider it tested, so
 * its cache entry is keyed by the saved provider: switching providers starts a fresh probe instead
 * of reusing the previous provider's answer for the rest of its five minutes.
 */
function useQuickStartProbe(live: boolean, status: QuickStartStatus | null): RpcProbeResult | null {
  // The probe answer lives in browser storage, so the server and the first client render both
  // read "checking"; the stored answer arrives on the next render instead of mismatching.
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
  const provider = status?.rpcProvider ?? "default";
  const { data: probe } = usePersistedDashboardSWR(
    live && status ? `${PROBE_KEY}:${provider}` : null,
    probeRpc,
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: PROBE_TTL_MS,
      refreshInterval: PROBE_TTL_MS,
    },
    { key: `quick-start-rpc-probe:${provider}`, ttlMs: PROBE_TTL_MS }
  );
  return hydrated ? (probe ?? null) : null;
}

/**
 * The quick start's state, shared by the Overview card, the sidebar card and Settings: who may
 * see it, the three resolved steps, and the person's choices. SWR dedupes the status read and
 * the probe across the surfaces mounted at once.
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
  const knownStatus = useQuickStartStatus(live);
  const settledProbe = useQuickStartProbe(live, knownStatus);

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
