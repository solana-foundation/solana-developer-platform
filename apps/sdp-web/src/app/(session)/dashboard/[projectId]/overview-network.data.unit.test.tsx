// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNetworkStatsFixture } from "./network-stats.fixture";
import { fetchNetworkSnapshot, useOverviewNetwork } from "./overview-network.data";

const FIXTURE = buildNetworkStatsFixture("2026-10-12");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => undefined));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useOverviewNetwork", () => {
  it("reports loading until the request answers, then the snapshot it answered", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ data: FIXTURE }));
    const { result } = renderHook(() => useOverviewNetwork(), { wrapper });
    expect(result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current).toEqual({ status: "ready", snapshot: FIXTURE }));
  });

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
