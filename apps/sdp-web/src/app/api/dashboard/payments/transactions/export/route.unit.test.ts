import type { UnifiedTransaction } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ request: mocks.request }),
}));

import { GET } from "./route";

function transaction(id: string): UnifiedTransaction {
  return {
    id,
    module: "payments",
    moduleId: id,
    kind: "pay",
    status: "succeeded",
    moduleStatus: "completed",
    organizationId: "org_1",
    projectId: null,
    amount: "1",
    token: null,
    counterpartyId: null,
    custodyWalletId: null,
    custodyWalletLabel: null,
    signature: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function page(ids: string[], nextCursor: string | null): Response {
  return Response.json({ data: { transactions: ids.map(transaction), nextCursor } });
}

function rateLimited(retryAfter: string | null): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Rate limit exceeded." } },
    { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } }
  );
}

function exportRequest(): Request {
  return new Request(
    "http://localhost/api/dashboard/payments/transactions/export?status=succeeded"
  );
}

/** Lets the route reach its next wait, then moves the clock past it. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("GET /api/dashboard/payments/transactions/export", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.request.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out a 429's Retry-After and reads the same page again", async () => {
    mocks.request
      .mockResolvedValueOnce(page(["txn_1"], "cursor_2"))
      .mockResolvedValueOnce(rateLimited("20"))
      .mockResolvedValueOnce(page(["txn_2"], null));

    const pending = GET(exportRequest());
    await advance(19_999);
    // Still waiting: the refused page is not read again before Retry-After.
    expect(mocks.request).toHaveBeenCalledTimes(2);
    await advance(1);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(3);
    // The retry asks for the page the quota refused, not the first one.
    expect(mocks.request.mock.calls[1]?.[0]).toBe(mocks.request.mock.calls[2]?.[0]);
    expect(mocks.request.mock.calls[2]?.[0]).toContain("cursor=cursor_2");
    const csv = await response.text();
    expect(csv).toContain("txn_1");
    expect(csv).toContain("txn_2");
  });

  it("answers 429 once the waiting budget is spent, without a partial CSV", async () => {
    // Each refusal asks for a full minute; the budget covers one wait and a few seconds more.
    mocks.request
      .mockResolvedValueOnce(page(["txn_1"], "cursor_2"))
      .mockResolvedValue(rateLimited("60"));

    const pending = GET(exportRequest());
    await advance(60_000);
    await advance(5_000);
    const response = await pending;

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", message: expect.stringContaining("Wait a minute") },
    });
    // The first page, then the refused page three times: after 60s, after the last 5s, and the
    // read that found the budget gone.
    expect(mocks.request).toHaveBeenCalledTimes(4);
  });

  it("waits a few seconds when a 429 names no Retry-After", async () => {
    mocks.request.mockResolvedValueOnce(rateLimited(null)).mockResolvedValueOnce(page([], null));

    const pending = GET(exportRequest());
    await advance(4_999);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await advance(1);

    expect((await pending).status).toBe(200);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("still passes any other failure straight through", async () => {
    mocks.request.mockResolvedValueOnce(
      Response.json({ error: { message: "Insufficient permissions" } }, { status: 403 })
    );

    const response = await GET(exportRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Insufficient permissions" },
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
