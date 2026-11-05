// @vitest-environment jsdom

import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardReadError } from "@/lib/dashboard-swr";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { useHomeActivitySnapshot } from "./home-workspace.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const ACTIVITY_PATH = "/api/dashboard/home/activity";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const SNAPSHOT = {
  activityRows: [
    {
      id: "payment-xfr_1",
      createdAt: "2026-10-23T12:00:00.000Z",
      type: "Send",
      token: "USDC",
      tokenMint: null,
      amount: "12.5",
      status: "completed",
      address: ADDRESS,
      explorer: { kind: "address", value: ADDRESS },
      sourceKind: "payments",
    },
  ],
  activityError: null,
  activityNotice: null,
  todaysVolume: {
    transferCount: 1,
    amountByMint: { [USDC_MINT]: "125" },
    complete: true,
    coversDay: true,
  },
  todaysVolumeError: null,
};

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useHomeActivitySnapshot", () => {
  const reads = (fetchMock: ReturnType<typeof respond>) =>
    fetchMock.mock.calls.filter(([path]) => path === ACTIVITY_PATH).length;

  it("returns the list and today's volume from one answer", async () => {
    respond(200, { data: SNAPSHOT });
    const { result } = renderHook(() => useHomeActivitySnapshot(true), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.data).toEqual(SNAPSHOT));
  });

  it.each([
    [
      "an answer without the volume, never a $0.00 day",
      { activityRows: [], activityError: null, activityNotice: null },
    ],
    [
      "a row the route could not have built",
      { ...SNAPSHOT, activityRows: [{ id: "payment-xfr_1" }] },
    ],
  ])("fails on %s", async (_case, data) => {
    respond(200, { data });
    const { result } = renderHook(() => useHomeActivitySnapshot(true), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(DashboardReadError));
    expect(result.current.data).toBeUndefined();
  });

  it("reads on mount, then once a minute", async () => {
    vi.useFakeTimers();
    const fetchMock = respond(200, { data: SNAPSHOT });
    renderHook(() => useHomeActivitySnapshot(true), { wrapper: DashboardReadsProvider });

    await vi.advanceTimersByTimeAsync(0);
    expect(reads(fetchMock)).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads(fetchMock)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads(fetchMock)).toBe(2);
  });

  it("reads nothing while disabled, however long the page stays open", async () => {
    vi.useFakeTimers();
    const fetchMock = respond(200, { data: SNAPSHOT });
    renderHook(() => useHomeActivitySnapshot(false), { wrapper: DashboardReadsProvider });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads(fetchMock)).toBe(0);
  });
});
