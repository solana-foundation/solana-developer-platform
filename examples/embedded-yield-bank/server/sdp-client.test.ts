import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoConfig } from "./env";
import { EmbeddedYieldClient } from "./sdp-client";

const config: DemoConfig = {
  SDP_API_BASE_URL: "http://127.0.0.1:8787",
  SDP_API_KEY: "test-api-key",
  DEMO_WALLET_PRIVATE_KEY: "test-private-key",
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

describe("EmbeddedYieldClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the complete strategy catalogue instead of stopping at page one", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `strategy-${index}`,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: { strategies: first, total: 101 } })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { strategies: [{ id: "strategy-100" }], total: 101 },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new EmbeddedYieldClient(config).listStrategies()
    ).resolves.toHaveLength(101);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:8787/v1/earn/discovery?page=1&pageSize=100",
      "http://127.0.0.1:8787/v1/earn/discovery?page=2&pageSize=100",
    ]);
  });

  it("refuses a strategy page that repeats without reaching the reported total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: { strategies: [{ id: "strategy-1" }], total: 2 },
        })
      )
    );

    await expect(
      new EmbeddedYieldClient(config).listStrategies()
    ).rejects.toThrow("pagination made no progress");
  });

  it("bounds a changing catalogue even while every page makes progress", async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      page += 1;
      return Response.json({
        data: {
          strategies: Array.from({ length: 100 }, (_, index) => ({
            id: `strategy-${page}-${index}`,
          })),
          total: 10_001,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new EmbeddedYieldClient(config).listStrategies()
    ).rejects.toThrow("pagination exceeded 100 pages");
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it("reads every position page and rejects a different owner", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            positions: [{ id: "first", source: { ownerAddress: "owner" } }],
            hasMore: true,
            nextCursor: "next",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            positions: [{ id: "second", source: { ownerAddress: "owner" } }],
            hasMore: false,
            nextCursor: null,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            positions: [{ id: "foreign", source: { ownerAddress: "other" } }],
            hasMore: false,
            nextCursor: null,
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmbeddedYieldClient(config);
    await expect(client.listPositions("owner")).resolves.toMatchObject([
      { id: "first", ownerAddress: "owner" },
      { id: "second", ownerAddress: "owner" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/v1/earn/positions?sourceType=address&ownerAddress=owner&discover=true&limit=100"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain("before=next");
    await expect(client.listPositions("owner")).rejects.toThrow(
      "Invalid position owner"
    );
  });

  it("rejects cycling position and operation cursors", async () => {
    const client = new EmbeddedYieldClient(config);
    for (const kind of ["positions", "operations"] as const) {
      const cursors = ["first", "second", "first"];
      const fetchMock = vi.fn(async () =>
        Response.json({
          data: { [kind]: [], hasMore: true, nextCursor: cursors.shift() },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        kind === "positions"
          ? client.listPositions("owner")
          : client.listOperations("owner")
      ).rejects.toThrow("cursor did not advance");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  });

  it("does not silently erase history on authorization or availability errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "Unavailable" } }, { status: 503 })
      )
    );
    await expect(
      new EmbeddedYieldClient(config).listOperations("owner")
    ).rejects.toMatchObject({ status: 503 });
  });
});
