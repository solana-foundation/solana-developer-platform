// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { buildNetworkStatsFixture } from "./network-stats.fixture";
import { useOverviewNetwork } from "./overview-network.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const FIXTURE = buildNetworkStatsFixture("2026-10-12");

beforeEach(() => {
  resetDashboardNavigation();
  vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useOverviewNetwork", () => {
  it("is loading until the first answer, then shows the snapshot it read", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ data: FIXTURE }));
    const { result } = renderHook(() => useOverviewNetwork(), { wrapper: DashboardReadsProvider });
    expect(result.current).toEqual({ status: "loading" });

    await waitFor(() => expect(result.current).toEqual({ status: "ready", snapshot: FIXTURE }));
  });

  it.each([
    ["is refused", () => new Response("down", { status: 503 })],
    ["answers in another shape", () => Response.json({ data: { asOf: "today" } })],
  ])("makes the section unavailable when the request %s", async (_case, answer) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(answer());
    const { result } = renderHook(() => useOverviewNetwork(), { wrapper: DashboardReadsProvider });
    await waitFor(() => expect(result.current).toEqual({ status: "unavailable" }));
  });
});
