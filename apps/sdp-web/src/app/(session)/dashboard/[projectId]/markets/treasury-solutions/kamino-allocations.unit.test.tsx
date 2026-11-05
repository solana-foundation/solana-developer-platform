// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import {
  kaminoAllocationsVault,
  kaminoAllocationsVaults,
  useKaminoVaultAllocations,
} from "./kamino-allocations";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const ALLOCATIONS_PATH = "/api/dashboard/markets/earn/kamino-allocations";

function payload() {
  return {
    asOf: "2026-09-14T17:53:52.895Z",
    allocations: [{ reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "23.94" }],
    unallocated: { pct: "0.06" },
  };
}

function requestedVaults(path: string): string[] {
  const vaults = new URL(path, "https://dashboard.test").searchParams.get("vaults");
  return vaults === null ? [] : vaults.split(",");
}

function answerEveryVault() {
  return stubDashboardFetch(({ path }) =>
    Response.json({
      vaults: Object.fromEntries(requestedVaults(path).map((vault) => [vault, payload()])),
    })
  );
}

function renderAllocations(vaults: readonly string[]) {
  return renderHook(() => useKaminoVaultAllocations(vaults), { wrapper: DashboardReadsProvider });
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
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads every vault in one request under the key's Project", async () => {
    const fetchMock = answerEveryVault();

    const { result } = renderAllocations(["Kvault1111", "Kvault2222"]);

    await waitFor(() => expect(result.current.allocationsByVault).toBeDefined());
    expect(result.current.error).toBeUndefined();
    expect(sentDashboardReads(fetchMock)).toEqual([
      {
        path: `${ALLOCATIONS_PATH}?cluster=mainnet-beta&vaults=Kvault1111%2CKvault2222`,
        projectId: SANDBOX_PROJECT.id,
        demo: null,
      },
    ]);
    expect(result.current.allocationsByVault?.Kvault2222?.allocations[0]?.marketName).toBe(
      "SOL/BTC Market"
    );
  });

  it("splits a list past one batch into mainnet reads of their own vaults and merges them", async () => {
    const fetchMock = answerEveryVault();
    const vaults = Array.from({ length: 150 }, (_, index) => `Kvault${index}`);

    const { result } = renderAllocations(vaults);

    await waitFor(() => expect(result.current.allocationsByVault).toBeDefined());
    expect(
      sentDashboardReads(fetchMock).map((read) => {
        const params = new URL(read.path, "https://dashboard.test").searchParams;
        return { cluster: params.get("cluster"), vaults: requestedVaults(read.path) };
      })
    ).toEqual([
      { cluster: "mainnet-beta", vaults: vaults.slice(0, 100) },
      { cluster: "mainnet-beta", vaults: vaults.slice(100) },
    ]);
    expect(result.current.allocationsByVault?.Kvault0).toEqual(payload());
    expect(result.current.allocationsByVault?.Kvault149).toEqual(payload());
  });

  it("issues no request when no row has a readable vault", () => {
    const fetchMock = answerEveryVault();

    const { result } = renderAllocations([]);

    expect(result.current.allocationsByVault).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes each vault into the request, never into the URL unescaped", async () => {
    const fetchMock = answerEveryVault();

    const { result } = renderAllocations(["5YxwKgsv+TdT/not=A RealKey"]);

    await waitFor(() => expect(result.current.allocationsByVault).toBeDefined());
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      `${ALLOCATIONS_PATH}?cluster=mainnet-beta&vaults=5YxwKgsv%2BTdT%2Fnot%3DA+RealKey`,
    ]);
  });

  it.each([
    ["a failed BFF read", () => dashboardErrorResponse(502, "Vault allocations could not be read")],
    [
      "a malformed BFF payload",
      () =>
        Response.json({
          vaults: { Kvault1111: { allocations: [{ marketName: "SOL/BTC Market" }] } },
        }),
    ],
  ])("surfaces %s as an error, never as partial data", async (_case, answer) => {
    stubDashboardFetch(answer);

    const { result } = renderAllocations(["Kvault1111"]);

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocationsByVault).toBeUndefined();
  });
});
