import { describe, expect, it, vi } from "vitest";
import {
  buildConnectionsSearchParams,
  ConnectionsRequestError,
  type CustodyConnectionListItem,
  fetchConnectionPickerOptions,
  fetchConnectionsPage,
  fetchProviderConnections,
  fetchWalletsByConnection,
  parseConnectionsFilters,
  summarizeProviderConnections,
} from "./connections.data";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function connection(id: string): CustodyConnectionListItem {
  return {
    id,
    provider: "privy",
    label: "Treasury",
    status: "active",
    isDefault: true,
    isRuntimeExecutionAllowed: true,
    defaultCustodyWalletId: "cwlt_treasury",
    createdAt: "2026-08-10T09:00:00.000Z",
    activatedAt: "2026-08-10T09:05:00.000Z",
    lastCheck: {
      status: "success",
      at: "2026-08-10T09:05:00.000Z",
      failureCode: null,
    },
    pendingWalletLabel: null,
  };
}

describe("parseConnectionsFilters", () => {
  it("defaults invalid pages to 1", () => {
    expect(parseConnectionsFilters({}).page).toBe(1);
    expect(parseConnectionsFilters({ page: "0" }).page).toBe(1);
    expect(parseConnectionsFilters({ page: "junk" }).page).toBe(1);
    expect(parseConnectionsFilters({ page: ["3", "9"] }).page).toBe(3);
  });
});

describe("buildConnectionsSearchParams", () => {
  it("omits the default page and keeps overrides", () => {
    expect(buildConnectionsSearchParams({ page: 2 }, { page: 1 }).toString()).toBe("");
    expect(buildConnectionsSearchParams({ page: 1 }, { page: 4 }).toString()).toBe("page=4");
  });
});

describe("fetchProviderConnections", () => {
  function slice(connections: CustodyConnectionListItem[], offset: number, total: number) {
    return jsonResponse({
      data: { connections, pagination: { limit: 50, offset, total } },
    });
  }

  // The narrowing is the server's, so the total it pages against is this
  // provider's total. Filtering after the read counted every provider's
  // connections towards a cap only one of them was meant to spend.
  it("asks the endpoint for one provider at the widest page size", async () => {
    const request = vi.fn(async () => slice([], 0, 0));

    await fetchProviderConnections(request, "privy");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=50&offset=0&provider=privy"
    );
  });

  it("pages until the project's total is covered", async () => {
    const first = Array.from({ length: 50 }, (_, index) => connection(`conn-${index}`));
    const request = vi
      .fn()
      .mockResolvedValueOnce(slice(first, 0, 51))
      .mockResolvedValueOnce(slice([connection("conn-50")], 50, 51));

    const project = await fetchProviderConnections(request, "privy");

    expect(project.connections).toHaveLength(51);
    expect(project.complete).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      "/internal/dashboard/custody/connections?limit=50&offset=50&provider=privy"
    );
  });

  it("reports an incomplete read rather than walking an unbounded list", async () => {
    const full = (offset: number) =>
      slice(
        Array.from({ length: 50 }, (_, index) => connection(`conn-${offset + index}`)),
        offset,
        1000
      );
    const request = vi.fn(async (path: string) =>
      full(Number(new URL(path, "https://sdp.test").searchParams.get("offset")))
    );

    const project = await fetchProviderConnections(request, "privy");

    expect(project.connections).toHaveLength(200);
    expect(project.complete).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
  });

  // A short page against a nonzero total means rows moved under the read.
  it("stops on an empty slice and admits the read was incomplete", async () => {
    const request = vi.fn(async () => slice([], 0, 12));

    const project = await fetchProviderConnections(request, "privy");

    expect(project.connections).toEqual([]);
    expect(project.complete).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts additive fields from a newer API response", async () => {
    const expectedConnection = connection("conn-1");
    const request = vi.fn(async () =>
      jsonResponse({
        data: {
          connections: [
            {
              ...expectedConnection,
              lastCheck: { ...expectedConnection.lastCheck, futureField: true },
              futureField: true,
            },
          ],
          pagination: { limit: 50, offset: 0, total: 1, futureField: true },
          futureField: true,
        },
        meta: { requestId: "req-connections", futureField: true },
        futureField: true,
      })
    );

    await expect(fetchProviderConnections(request, "privy")).resolves.toEqual({
      connections: [expectedConnection],
      complete: true,
    });
  });

  it("throws a typed error carrying the response status", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(fetchProviderConnections(request, "privy")).rejects.toMatchObject({
      name: "ConnectionsRequestError",
      status: 403,
    });
    await expect(fetchProviderConnections(request, "privy")).rejects.toBeInstanceOf(
      ConnectionsRequestError
    );
  });

  it("rejects a malformed successful response", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ data: { connections: [{ id: "conn-1" }], pagination: {} } })
    );

    await expect(fetchProviderConnections(request, "privy")).rejects.toThrow();
  });
});

describe("fetchConnectionsPage", () => {
  function page(connections: CustodyConnectionListItem[], offset: number, total: number) {
    return jsonResponse({
      data: { connections, pagination: { limit: 20, offset, total } },
    });
  }

  it("asks the server for exactly the page on screen", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => connection(`conn-${index}`));
    const request = vi.fn(async () => page(rows, 20, 25));

    const { result, filters } = await fetchConnectionsPage(request, "privy", { page: 2 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=20&offset=20&provider=privy"
    );
    expect(filters.page).toBe(2);
    expect(result.pagination).toEqual({ limit: 20, offset: 20, total: 25 });
  });

  // The whole point of the provider parameter: page 11 of a project whose
  // privy connections start past the first 200 rows of every provider's is a
  // single indexed read, not an inventory walk that gave up before reaching it.
  it("reaches a deep page without reading everything before it", async () => {
    const request = vi.fn(async () => page([connection("conn-deep")], 200, 240));

    const { result } = await fetchConnectionsPage(request, "privy", { page: 11 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.connections.map((row) => row.id)).toEqual(["conn-deep"]);
  });

  it("lands on the last page that exists when the bookmark is stale", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => connection(`conn-${index}`));
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([], 160, 25))
      .mockResolvedValueOnce(page(rows, 20, 25));

    const { result, filters } = await fetchConnectionsPage(request, "privy", { page: 9 });

    expect(filters.page).toBe(2);
    expect(result.connections).toHaveLength(5);
    expect(request).toHaveBeenLastCalledWith(
      "/internal/dashboard/custody/connections?limit=20&offset=20&provider=privy"
    );
  });

  // An empty page 1 is the empty state, not a stale URL — re-reading it would
  // only ask the same question twice.
  it("leaves an empty project on page 1 after one request", async () => {
    const request = vi.fn(async () => page([], 0, 0));

    const { result, filters } = await fetchConnectionsPage(request, "privy", { page: 1 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(filters.page).toBe(1);
    expect(result.connections).toEqual([]);
  });

  it("throws a typed error carrying the response status", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(fetchConnectionsPage(request, "privy", { page: 1 })).rejects.toMatchObject({
      name: "ConnectionsRequestError",
      status: 403,
    });
  });
});

describe("summarizeProviderConnections", () => {
  const paused = (id: string) => ({
    ...connection(id),
    isDefault: false,
    isRuntimeExecutionAllowed: false,
  });

  it("finds a default that no single page would have shown", () => {
    const summary = summarizeProviderConnections({
      connections: [paused("conn-a"), connection("conn-default")],
      complete: true,
    });

    expect(summary.defaultConnection).toEqual({ id: "conn-default", label: "Treasury" });
    expect(summary.activeCount).toBe(2);
  });

  it("pauses signing only when every active connection is paused", () => {
    expect(
      summarizeProviderConnections({
        connections: [paused("conn-a"), paused("conn-b")],
        complete: true,
      }).signingPaused
    ).toBe(true);

    expect(
      summarizeProviderConnections({
        connections: [paused("conn-a"), connection("conn-live")],
        complete: true,
      }).signingPaused
    ).toBe(false);
  });

  it("ignores connections that are not active", () => {
    const summary = summarizeProviderConnections({
      connections: [
        { ...connection("conn-dead"), status: "deactivated" as const },
        { ...connection("conn-pending"), status: "pending" as const },
      ],
      complete: true,
    });

    expect(summary.activeCount).toBe(0);
    expect(summary.defaultConnection).toBeNull();
    expect(summary.signingPaused).toBe(false);
  });

  it("carries the incompleteness through, so callers can stay quiet", () => {
    expect(
      summarizeProviderConnections({ connections: [paused("conn-a")], complete: false }).complete
    ).toBe(false);
  });
});

describe("fetchWalletsByConnection", () => {
  it("groups connection-owned wallets and drops config-owned ones", async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        data: {
          wallets: [
            { walletId: "w-1", custodyConnectionId: "conn-1" },
            { walletId: "w-2", custodyConnectionId: "conn-1" },
            { walletId: "w-3", custodyConfigId: "config-1" },
            { walletId: "w-4", custodyConnectionId: "conn-2" },
          ],
        },
      })
    );

    const byConnection = await fetchWalletsByConnection(request);

    expect(request).toHaveBeenCalledWith("/v1/wallets?includeAllProviders=true");
    expect([...byConnection.keys()].sort()).toEqual(["conn-1", "conn-2"]);
    expect(byConnection.get("conn-1")?.map((wallet) => wallet.walletId)).toEqual(["w-1", "w-2"]);
  });
});

describe("fetchConnectionPickerOptions", () => {
  function page(connections: CustodyConnectionListItem[]): Response {
    return jsonResponse({
      data: {
        connections,
        pagination: { limit: 50, offset: 0, total: connections.length },
      },
    });
  }

  it("keeps unusable connections so the picker can explain them", async () => {
    const pending = { ...connection("conn-pending"), status: "pending" as const };
    const failed = { ...connection("conn-failed"), status: "failed" as const };
    const request = vi.fn(async () => page([connection("conn-active"), pending, failed]));

    const options = await fetchConnectionPickerOptions(request, "privy");

    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=50&offset=0&provider=privy"
    );
    expect(options.map((option) => option.id)).toEqual([
      "conn-active",
      "conn-pending",
      "conn-failed",
    ]);
  });

  it("drops deactivated connections", async () => {
    const deactivated = { ...connection("conn-dead"), status: "deactivated" as const };
    const request = vi.fn(async () => page([connection("conn-active"), deactivated]));

    const options = await fetchConnectionPickerOptions(request, "privy");

    expect(options.map((option) => option.id)).toEqual(["conn-active"]);
  });

  // The endpoint needs custody:admin, which creating a wallet does not.
  it("returns nothing rather than throwing when the read is refused", async () => {
    const request = vi.fn(async () => new Response("forbidden", { status: 403 }));

    await expect(fetchConnectionPickerOptions(request, "privy")).resolves.toEqual([]);
  });

  it("returns nothing when the payload does not match the schema", async () => {
    const request = vi.fn(async () => jsonResponse({ data: { connections: "nope" } }));

    await expect(fetchConnectionPickerOptions(request, "privy")).resolves.toEqual([]);
  });
});
