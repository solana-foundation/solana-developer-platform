// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { fetchHomeActivity, useHomeActivitySnapshot } from "./home-workspace.data";

// The saved snapshot is scoped to the viewer's workspace.
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user_home", orgId: "org_home" },
    selectedProjectId: "prj_home",
  }),
}));

const ACTIVITY_PATH = "/api/dashboard/home/activity";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
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
  todaysVolume: 125,
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
  window.localStorage.clear();
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}`);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("fetchHomeActivity", () => {
  it("returns the list and today's volume from one answer", async () => {
    respond(200, { data: SNAPSHOT });

    await expect(fetchHomeActivity()).resolves.toEqual(SNAPSHOT);
  });

  it("rejects an answer without the volume instead of reading it as a $0.00 day", async () => {
    respond(200, { data: { activityRows: [], activityError: null, activityNotice: null } });

    await expect(fetchHomeActivity()).rejects.toThrow();
  });

  it("rejects a row the route could not have built", async () => {
    respond(200, { data: { ...SNAPSHOT, activityRows: [{ id: "payment-xfr_1" }] } });

    await expect(fetchHomeActivity()).rejects.toThrow();
  });

  it("rejects a failed read without the route's text, so each section words its own", async () => {
    respond(500, { error: "client unavailable" });

    await expect(fetchHomeActivity()).rejects.toMatchObject({ message: "" });
  });
});

describe("useHomeActivitySnapshot", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      children
    );
  const reads = (fetchMock: ReturnType<typeof respond>) =>
    fetchMock.mock.calls.filter(([path]) => path === ACTIVITY_PATH).length;

  it("reads on mount, then once a minute", async () => {
    vi.useFakeTimers();
    const fetchMock = respond(200, { data: SNAPSHOT });
    renderHook(() => useHomeActivitySnapshot(true), { wrapper });

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
    renderHook(() => useHomeActivitySnapshot(false), { wrapper });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads(fetchMock)).toBe(0);
  });
});
