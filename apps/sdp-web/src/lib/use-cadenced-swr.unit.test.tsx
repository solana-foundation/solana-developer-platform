// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { dashboardRequestKey, readsUnderPath } from "./dashboard-request-key";
import { useInvalidateDashboardReads } from "./dashboard-swr";
import { useCadencedDashboardSWR, useCadencedSWR } from "./use-cadenced-swr";

// Real timers with wide margins: each cadence is far longer than a React
// commit, so a busy machine cannot reorder a poll and the commit that stops it.
const CADENCE_MS = 100;
const ACTIVITY_KEY = dashboardRequestKey(
  { projectId: SANDBOX_PROJECT.id, mode: "live" },
  "/api/dashboard/wallets/wal_test_1/activity"
);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
});

describe("useCadencedSWR", () => {
  it("starts polling once the first read asks for it, from a cold mount that said stop", async () => {
    const fetcher = vi.fn(async () => ({ busy: true }));
    renderHook(() => useCadencedSWR("cold", fetcher, (data) => (data?.busy ? CADENCE_MS : 0)), {
      wrapper,
    });

    // A function interval read once at mount would stay at 0 and never poll.
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
    });
  });

  it("stops polling when the latest read asks for 0", async () => {
    let reads = 0;
    const fetcher = vi.fn(async () => ({ done: ++reads >= 2 }));
    renderHook(() => useCadencedSWR("stops", fetcher, (data) => (data?.done ? 0 : CADENCE_MS)), {
      wrapper,
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 4 * CADENCE_MS));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps its timer through re-renders that leave the cadence unchanged", async () => {
    const fetcher = vi.fn(async () => ({ live: true }));
    const { rerender } = renderHook(() => useCadencedSWR("steady", fetcher, () => CADENCE_MS), {
      wrapper,
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // A page re-rendering faster than the cadence: an inline function interval would restart
    // the timer on each render and never poll.
    const renders = setInterval(() => act(() => rerender()), CADENCE_MS / 10);
    try {
      await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3), {
        timeout: 2_000,
      });
    } finally {
      clearInterval(renders);
    }
  });
});

describe("useCadencedDashboardSWR", () => {
  it("starts polling once the first read asks for it, from a cold mount that said stop", async () => {
    const fetcher = vi.fn(async () => ({ busy: true }));
    renderHook(
      () =>
        useCadencedDashboardSWR(ACTIVITY_KEY, fetcher, (data) => (data?.busy ? CADENCE_MS : 0), {}),
      { wrapper }
    );

    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
    });
  });

  it("keeps its data on screen through an invalidation, which refetches it", async () => {
    let answer = "before";
    const fetcher = vi.fn(async () => answer);
    const shown: unknown[] = [];
    const { result } = renderHook(
      () => {
        const read = useCadencedDashboardSWR(ACTIVITY_KEY, fetcher, () => 0, {});
        shown.push(read.data);
        return { read, invalidate: useInvalidateDashboardReads() };
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.read.data).toBe("before"));
    const shownBeforeInvalidation = shown.length;
    answer = "after";

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));

    await waitFor(() => expect(result.current.read.data).toBe("after"));
    expect(shown.slice(shownBeforeInvalidation)).not.toContain(undefined);
  });
});
