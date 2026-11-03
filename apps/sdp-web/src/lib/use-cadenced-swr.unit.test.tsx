// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCadencedSWR } from "./use-cadenced-swr";

// Real timers with wide margins: each cadence is far longer than a React
// commit, so a busy machine cannot reorder a poll and the commit that stops it.
const CADENCE_MS = 100;

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
