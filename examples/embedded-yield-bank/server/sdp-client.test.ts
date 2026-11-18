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

  it("reads a movement through the chain-aware detail endpoint", async () => {
    const movement = {
      movementId: "movement/with space",
      status: "confirmed",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { movement } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new EmbeddedYieldClient(config).getMovement(movement.movementId)
    ).resolves.toEqual(movement);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8787/v1/earn/external-wallet/movements/movement%2Fwith%20space"
    );
  });

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

  it("resumes an already-built request and builds its keyed cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { withdrawalRequest: { withdrawalRequestId: "request" } },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            transaction: {
              transactionId: "cancel-build",
              transaction: "base64",
              lastValidBlockHeight: "101",
              ownerAddress: "customer",
              provider: "veda",
              positionId: "position",
              action: "cancel",
              requestAddress: "request-address",
              withdrawalRequestId: "request",
            },
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { withdrawalRequest: { withdrawalRequestId: "request" } },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new EmbeddedYieldClient(config);

    await client.submitQueuedWithdrawalRequest(
      "request-build",
      "signed",
      "request-key"
    );
    await client.buildQueuedWithdrawalCancellation({
      withdrawalRequestId: "request",
    });
    await client.submitQueuedWithdrawalCancellation(
      "cancel-build",
      "signed",
      "cancel-key"
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:8787/v1/earn/external-wallet/withdrawal-requests",
      "http://127.0.0.1:8787/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
      "http://127.0.0.1:8787/v1/earn/external-wallet/withdrawal-request-cancellations",
    ]);
    const requestSubmit = fetchMock.mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const cancelSubmit = fetchMock.mock.calls[2]?.[1] as
      | RequestInit
      | undefined;
    expect(new Headers(requestSubmit?.headers).get("Idempotency-Key")).toBe(
      "request-key"
    );
    expect(new Headers(cancelSubmit?.headers).get("Idempotency-Key")).toBe(
      "cancel-key"
    );
  });

  it("restores every non-terminal queued withdrawal and fails a stuck cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            withdrawalRequests: [{ withdrawalRequestId: "request-1" }],
            hasMore: true,
            nextCursor: "cursor-1",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            withdrawalRequests: [{ withdrawalRequestId: "request-2" }],
            hasMore: false,
            nextCursor: null,
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new EmbeddedYieldClient(config).listPendingWithdrawalRequests("owner")
    ).resolves.toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("settled=false");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("before=cursor-1");

    const cyclingResponses = ["cursor-1", "cursor-2", "cursor-1"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            withdrawalRequests: [],
            hasMore: true,
            nextCursor: cyclingResponses.shift(),
          },
        })
      )
    );
    await expect(
      new EmbeddedYieldClient(config).listPendingWithdrawalRequests("owner")
    ).rejects.toThrow("cursor did not advance");
  });
});
