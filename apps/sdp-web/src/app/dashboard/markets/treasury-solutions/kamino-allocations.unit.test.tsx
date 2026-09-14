// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKaminoVaultAllocations } from "./kamino-allocations";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@/lib/dashboard-fetch", () => ({
  dashboardFetch: mocks.fetch,
}));

function payload() {
  return {
    asOf: "2026-09-14T17:53:52.895Z",
    allocations: [
      {
        reserve: "reserve-1",
        marketName: "SOL/BTC Market",
        symbol: "SOL",
        actualPct: "23.94",
        supplyApy: "0.045",
      },
    ],
    unallocated: { pct: "0.06", usd: "349.54" },
  };
}

// Each test renders inside an isolated SWR cache so a previous test's data
// never serves (or suppresses the fetch of) a later read.
function renderIsolatedHook(vault: string | undefined) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
  );
  return renderHook(() => useKaminoVaultAllocations(vault), { wrapper });
}

describe("useKaminoVaultAllocations", () => {
  beforeEach(() => {
    mocks.fetch.mockResolvedValue({ ok: true, data: payload(), status: 200 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads one vault's allocations through the BFF seam", async () => {
    const { result } = renderIsolatedHook("Kvault1111");

    await waitFor(() => expect(result.current.allocations).toBeDefined());
    expect(result.current.error).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/dashboard/markets/earn/kamino-allocations?vault=Kvault1111"
    );
    expect(result.current.allocations?.allocations[0]?.symbol).toBe("SOL");
  });

  it("issues no request for a row without a vault reference", async () => {
    const { result } = renderIsolatedHook(undefined);

    expect(result.current.allocations).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("encodes the vault into the request, never into the URL unescaped", async () => {
    const { result } = renderIsolatedHook("5YxwKgsv+TdT/not=A RealKey");
    await waitFor(() => expect(result.current.allocations).toBeDefined());
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/dashboard/markets/earn/kamino-allocations?vault=${encodeURIComponent(
        "5YxwKgsv+TdT/not=A RealKey"
      )}`
    );
  });

  it("surfaces a failed BFF read as an error with no data", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      error: "Vault allocations could not be read",
      status: 502,
      body: null,
    });

    const { result } = renderIsolatedHook("Kvault1111");

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocations).toBeUndefined();
  });

  it("surfaces a malformed BFF payload as an error, never as partial data", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      data: { allocations: [{ symbol: "SOL" }] },
      status: 200,
    });

    const { result } = renderIsolatedHook("Kvault1111");

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocations).toBeUndefined();
  });
});
