import { describe, expect, it, vi } from "vitest";
import {
  buildConnectionsSearchParams,
  ConnectionsRequestError,
  fetchConnectionsPage,
  fetchWalletsByConnection,
  parseConnectionsFilters,
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
