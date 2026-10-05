// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenLifecycle } from "./issuance-token-state.redesign";
import { useLatestDeploys } from "./use-latest-deploys.redesign";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const deploys: Record<string, Array<{ status: string; createdAt: string }>> = {
  deploying: [
    { status: "failed", createdAt: "2026-09-30T10:00:00.000Z" },
    { status: "processing", createdAt: "2026-10-01T10:00:00.000Z" },
  ],
  failed: [{ status: "failed", createdAt: "2026-10-01T10:00:00.000Z" }],
  untouched: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("useLatestDeploys", () => {
  it("reads the latest deploy of each row with no mint, and only those", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("/tokens/")[1]?.split("/")[0] ?? "");
      return new Response(JSON.stringify({ data: deploys[id] ?? [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = [
      { id: "deploying", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "failed", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "untouched", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "live", mintAddress: "Mint111", deployedAt: "2026-09-01T00:00:00Z", status: "active" },
    ];
    const { result } = renderHook(() => useLatestDeploys(tokens), { wrapper });

    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/tokens/live/"))).toBe(false);
    expect(result.current).toEqual({ deploying: "processing", failed: "failed", untouched: null });
    expect(tokens.map((token) => tokenLifecycle(token, result.current[token.id] ?? null))).toEqual([
      "deploying",
      "failed",
      "draft",
      "live",
    ]);
  });

  it("reads nothing when every row is on chain", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () =>
        useLatestDeploys([
          { id: "live", mintAddress: "Mint111", deployedAt: "2026-09-01T00:00:00Z" },
        ]),
      { wrapper }
    );
    expect(result.current).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
