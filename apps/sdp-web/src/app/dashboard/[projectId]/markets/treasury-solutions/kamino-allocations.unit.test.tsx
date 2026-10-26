// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  kaminoAllocationsVault,
  kaminoAllocationsVaults,
  useKaminoVaultAllocations,
} from "./kamino-allocations";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@/lib/dashboard-fetch", () => ({
  dashboardFetch: mocks.fetch,
}));

function payload() {
  return {
    asOf: "2026-09-14T17:53:52.895Z",
    allocations: [{ reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "23.94" }],
    unallocated: { pct: "0.06" },
  };
}

// Each test renders inside an isolated SWR cache so a previous test's data
// never serves (or suppresses the fetch of) a later read.
function renderIsolatedHook(vaults: readonly string[]) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
  );
  return renderHook(() => useKaminoVaultAllocations(vaults), { wrapper });
}

const kamino = (providerReference: string, hostCluster: "devnet" | "mainnet-beta") => ({
  provider: "kamino",
  providerReference,
  hostCluster,
});

describe("kaminoAllocationsVaults", () => {
  it("lists each mainnet Kamino vault once, sorted, whatever the row order", () => {
    expect(
      kaminoAllocationsVaults([
        kamino("KvaultB", "mainnet-beta"),
        kamino("KvaultA", "mainnet-beta"),
        kamino("KvaultB", "mainnet-beta"),
      ])
    ).toEqual(["KvaultA", "KvaultB"]);
  });

  it("leaves out rows the mainnet-only source cannot describe", () => {
    // A devnet vault is an unsupported read, never a doomed upstream call.
    expect(kaminoAllocationsVault(kamino("KvaultDevnet", "devnet"))).toBeUndefined();
    expect(
      kaminoAllocationsVault({
        provider: "veda",
        providerReference: "VedaFund",
        hostCluster: "mainnet-beta",
      })
    ).toBeUndefined();
    expect(kaminoAllocationsVaults([kamino("KvaultDevnet", "devnet")])).toEqual([]);
  });
});

describe("useKaminoVaultAllocations", () => {
  beforeEach(() => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      data: { vaults: { Kvault1111: payload(), Kvault2222: payload() } },
      status: 200,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads every vault in one request through the BFF seam", async () => {
    const { result } = renderIsolatedHook(["Kvault1111", "Kvault2222"]);

    await waitFor(() => expect(result.current.allocationsByVault).toBeDefined());
    expect(result.current.error).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/dashboard/markets/earn/kamino-allocations?vaults=Kvault1111,Kvault2222&cluster=mainnet-beta"
    );
    expect(result.current.allocationsByVault?.Kvault2222?.allocations[0]?.marketName).toBe(
      "SOL/BTC Market"
    );
  });

  it("issues no request when no row has a readable vault", async () => {
    const { result } = renderIsolatedHook([]);

    expect(result.current.allocationsByVault).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("encodes each vault into the request, never into the URL unescaped", async () => {
    const { result } = renderIsolatedHook(["5YxwKgsv+TdT/not=A RealKey"]);
    await waitFor(() => expect(result.current.allocationsByVault).toBeDefined());
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/dashboard/markets/earn/kamino-allocations?vaults=${encodeURIComponent(
        "5YxwKgsv+TdT/not=A RealKey"
      )}&cluster=mainnet-beta`
    );
  });

  it("surfaces a failed BFF read as an error with no data", async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      error: "Vault allocations could not be read",
      status: 502,
      body: null,
    });

    const { result } = renderIsolatedHook(["Kvault1111"]);

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocationsByVault).toBeUndefined();
  });

  it("surfaces a malformed BFF payload as an error, never as partial data", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      data: { vaults: { Kvault1111: { allocations: [{ marketName: "SOL/BTC Market" }] } } },
      status: 200,
    });

    const { result } = renderIsolatedHook(["Kvault1111"]);

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocationsByVault).toBeUndefined();
  });
});
