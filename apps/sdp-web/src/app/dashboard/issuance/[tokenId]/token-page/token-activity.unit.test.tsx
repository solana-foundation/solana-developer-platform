// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTokenActivityWindows } from "./token-activity";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
    {children}
  </SWRConfig>
);

const event = (id: string) => ({
  id,
  action: "mint",
  status: "success",
  actorType: "user",
  actorLabel: "Ada",
  createdAt: "2026-10-01T10:00:00.000Z",
});

afterEach(() => vi.unstubAllGlobals());

describe("useTokenActivityWindows", () => {
  it("keeps the loaded events when an older window fails, and retries that window", async () => {
    let olderFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const page = new URL(url, "http://localhost").searchParams.get("page");
        if (page === "2" && olderFails) {
          return new Response(JSON.stringify({ data: [], error: "Audit API 503" }), {
            status: 503,
          });
        }
        const data = page === "1" ? [event("newest")] : [event("older")];
        return new Response(
          JSON.stringify({ data, error: null, total: 2, hasMore: page === "1" }),
          { status: 200 }
        );
      })
    );

    const { result } = renderHook(() => useTokenActivityWindows("token_1", {}), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadOlder();
    });
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.error).toBeUndefined();
    expect(result.current.events.map((entry) => entry.id)).toEqual(["newest"]);

    olderFails = false;
    await act(async () => {
      await result.current.loadOlder();
    });
    await waitFor(() =>
      expect(result.current.events.map((entry) => entry.id)).toEqual(["newest", "older"])
    );
    expect(result.current.olderFailed).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });
});
