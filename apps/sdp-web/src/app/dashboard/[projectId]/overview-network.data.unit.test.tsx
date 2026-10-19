// @vitest-environment jsdom

import { NETWORK_METRIC_IDS, type NetworkSnapshot } from "@sdp/types/network-metrics";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNetworkStatsFixture } from "./network-stats.fixture";
import { fetchNetworkSnapshot, useOverviewNetwork } from "./overview-network.data";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user", orgId: "org" },
    selectedProjectId: "project",
  }),
}));

const STORAGE_KEY = "sdp.dashboard.cache.user:org:project.home-network";
const FIXTURE = buildNetworkStatsFixture("2026-10-12");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

/** The metrics as a list, as versions 1 and 2 saved them before they were keyed by reading. */
const LISTED_METRICS = NETWORK_METRIC_IDS.map((id) => ({ id, points: FIXTURE.metrics[id] }));

/** What older versions saved: health as a bare state (1), and the metrics as a list (1 and 2). */
const OLDER_SNAPSHOTS = [
  [1, { ...FIXTURE, health: "operational", metrics: LISTED_METRICS }],
  [2, { ...FIXTURE, metrics: LISTED_METRICS }],
] as const;

function saveSnapshot(version: number, value: NetworkSnapshot | Record<string, unknown>) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ expiresAt: Date.now() + 60_000, version, value })
  );
}

beforeEach(() => {
  // The real request stays in flight: these cases are about what the saved copy paints.
  vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useOverviewNetwork", () => {
  it("paints a saved snapshot at once", () => {
    saveSnapshot(3, FIXTURE);
    const { result } = renderHook(() => useOverviewNetwork(), { wrapper });
    expect(result.current).toEqual({ status: "ready", snapshot: FIXTURE });
  });

  it.each(OLDER_SNAPSHOTS)(
    "drops a snapshot version %i saved, rather than drawing an old shape",
    (version, value) => {
      saveSnapshot(version, value);
      const { result } = renderHook(() => useOverviewNetwork(), { wrapper });
      expect(result.current).toEqual({ status: "loading" });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    }
  );

  it.each([
    ["is refused", () => new Response("down", { status: 503 })],
    ["answers in another shape", () => Response.json({ data: { asOf: "today" } })],
  ])("makes the section unavailable when the request %s", async (_case, answer) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(answer());
    const { result } = renderHook(() => useOverviewNetwork(), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ status: "unavailable" }));
  });
});

describe("fetchNetworkSnapshot", () => {
  it("throws on a refused request", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("down", { status: 503 }));
    await expect(fetchNetworkSnapshot()).rejects.toThrow("Network figures request failed (503)");
  });

  it("throws on an answer that is not a snapshot, never reading it as no data", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ data: { asOf: "today" } }));
    await expect(fetchNetworkSnapshot()).rejects.toThrow();
  });
});
