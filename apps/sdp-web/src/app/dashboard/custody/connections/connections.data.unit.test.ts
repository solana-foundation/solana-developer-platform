import { describe, expect, it, vi } from "vitest";
import {
  buildConnectionsSearchParams,
  ConnectionsRequestError,
  fetchConnectionsPage,
  fetchWalletsByConnection,
  parseConnectionsFilters,
  resolveConnectionsPage,
} from "./connections.data";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

describe("fetchConnectionsPage", () => {
  it("converts the page to a limit/offset query", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ data: { connections: [], pagination: { limit: 20, offset: 40, total: 0 } } })
    );

    await fetchConnectionsPage(request, { page: 3 });

    expect(request).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections?limit=20&offset=40"
    );
  });

  it("throws a typed error carrying the response status", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(fetchConnectionsPage(request, { page: 1 })).rejects.toMatchObject({
      name: "ConnectionsRequestError",
      status: 403,
    });
    await expect(fetchConnectionsPage(request, { page: 1 })).rejects.toBeInstanceOf(
      ConnectionsRequestError
    );
  });
});

describe("resolveConnectionsPage", () => {
  it("clamps an out-of-range page to the last real page and refetches", async () => {
    const request = vi.fn(async (path: string) =>
      path.includes("offset=20")
        ? jsonResponse({
            data: { connections: [], pagination: { limit: 20, offset: 20, total: 4 } },
          })
        : jsonResponse({
            data: {
              connections: [{ id: "conn-1" }],
              pagination: { limit: 20, offset: 0, total: 4 },
            },
          })
    );

    const { result, filters } = await resolveConnectionsPage(request, { page: 2 });

    expect(filters.page).toBe(1);
    expect(result.connections).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to page 1 when the total shrinks between the two reads", async () => {
    const empty = (offset: number, total: number) =>
      jsonResponse({ data: { connections: [], pagination: { limit: 20, offset, total } } });
    const request = vi
      .fn()
      // Requested page 5: empty, total says 4 pages exist.
      .mockResolvedValueOnce(empty(80, 70))
      // Clamped page 4: rows were deleted meanwhile, still empty past the end.
      .mockResolvedValueOnce(empty(60, 20))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            connections: [{ id: "conn-1" }],
            pagination: { limit: 20, offset: 0, total: 20 },
          },
        })
      );

    const { result, filters } = await resolveConnectionsPage(request, { page: 5 });

    expect(filters.page).toBe(1);
    expect(result.connections).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith(
      "/internal/dashboard/custody/connections?limit=20&offset=0"
    );
  });

  it("funnels an in-range page that lost its rows down to page 1", async () => {
    const request = vi
      .fn()
      // Page 2 is in range per the stale total, but deletions emptied it.
      .mockResolvedValueOnce(
        jsonResponse({
          data: { connections: [], pagination: { limit: 20, offset: 20, total: 25 } },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            connections: [{ id: "conn-1" }],
            pagination: { limit: 20, offset: 0, total: 5 },
          },
        })
      );

    const { result, filters } = await resolveConnectionsPage(request, { page: 2 });

    expect(filters.page).toBe(1);
    expect(result.connections).toHaveLength(1);
    // The clamp target equals the requested page here, so it goes straight to page 1.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns a genuinely empty last page untouched", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ data: { connections: [], pagination: { limit: 20, offset: 0, total: 0 } } })
    );

    const { result, filters } = await resolveConnectionsPage(request, { page: 1 });

    expect(filters.page).toBe(1);
    expect(result.pagination.total).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
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
