import type { UnifiedTransaction } from "@sdp/types/unified-transactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboardFlags from "@/flags/dashboard";
import * as sdpApi from "@/lib/sdp-api";
import { expectDashboardNoStore } from "@/test/dashboard-response";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { required } from "@/test/required";
import { GET } from "./route";

const request = vi.fn<(path: string) => Promise<Response>>();

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

function exportRequest(query = "?status=succeeded"): Request {
  return new Request(`http://localhost/api/dashboard/payments/transactions/export${query}`);
}

function requestedPaths(): string[] {
  return request.mock.calls.map(([path]) => path);
}

/** The id column of each CSV line, header first; a line without one fails the test. */
function exportedIds(csv: string): string[] {
  return csv
    .trimEnd()
    .split("\r\n")
    .map((line) => required(line.split(",")[1]));
}

/** Lets the route reach its next wait, then moves the clock past it. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("GET /api/dashboard/payments/transactions/export", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
    request.mockReset();
    vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({
      request,
      fetch: async () => {
        throw new Error("The export reads through request()");
      },
    });
    vi.spyOn(dashboardFlags, "getDashboardFlags").mockResolvedValue(dashboardFlagsAt("stable"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports every page with the list's filters, from the first page, as a CSV file", async () => {
    request
      .mockResolvedValueOnce(page(["txn_1"], "cursor_2"))
      .mockResolvedValueOnce(page(["txn_2"], null));

    const response = await GET(
      exportRequest("?status=succeeded&counterpartyId=cpty_1&cursor=c9&cursors=c8&pageSize=50")
    );

    expect(requestedPaths()).toEqual([
      "/v1/transactions?limit=100&status=succeeded&counterpartyId=cpty_1",
      "/v1/transactions?limit=100&status=succeeded&counterpartyId=cpty_1&cursor=cursor_2",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="sdp-transactions-2026-10-02.csv"'
    );
    expectDashboardNoStore(response);
    expect(await response.text()).toBe(
      [
        "createdAt,id,module,moduleId,kind,status,moduleStatus,amount,token,counterpartyId,custodyWalletId,custodyWalletLabel,signature",
        "2026-10-01T00:00:00.000Z,txn_1,payments,txn_1,pay,succeeded,completed,1,,,,,",
        "2026-10-01T00:00:00.000Z,txn_2,payments,txn_2,pay,succeeded,completed,1,,,,,",
        "",
      ].join("\r\n")
    );
  });

  it("stops at 5,000 rows however many pages remain", async () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `txn_${index}`);
    request.mockImplementation(async () => page(hundred, "more"));

    const response = await GET(exportRequest());

    expect(request).toHaveBeenCalledTimes(50);
    const ids = exportedIds(await response.text());
    expect(ids).toHaveLength(5_001);
    expect(ids.slice(0, 2)).toEqual(["id", "txn_0"]);
  });

  it("waits out a 429's Retry-After and reads the same page again", async () => {
    request
      .mockResolvedValueOnce(page(["txn_1"], "cursor_2"))
      .mockResolvedValueOnce(rateLimited("20"))
      .mockResolvedValueOnce(page(["txn_2"], null));

    const pending = GET(exportRequest());
    await advance(19_999);
    expect(request).toHaveBeenCalledTimes(2);
    await advance(1);
    const response = await pending;

    expect(response.status).toBe(200);
    expect(requestedPaths()).toEqual([
      "/v1/transactions?limit=100&status=succeeded",
      "/v1/transactions?limit=100&status=succeeded&cursor=cursor_2",
      "/v1/transactions?limit=100&status=succeeded&cursor=cursor_2",
    ]);
    expect(exportedIds(await response.text())).toEqual(["id", "txn_1", "txn_2"]);
  });

  it("answers 429 once the waiting budget is spent, without a partial CSV", async () => {
    request.mockResolvedValueOnce(page(["txn_1"], "cursor_2")).mockResolvedValue(rateLimited("60"));

    const pending = GET(exportRequest());
    await advance(60_000);
    await advance(5_000);
    const response = await pending;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many transaction reads to finish the export. Wait a minute and try again.",
      },
    });
  });

  it("waits a few seconds when a 429 names no Retry-After", async () => {
    request.mockResolvedValueOnce(rateLimited(null)).mockResolvedValueOnce(page([], null));

    const pending = GET(exportRequest());
    await advance(4_999);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);

    expect((await pending).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("passes any other failure straight through", async () => {
    request.mockResolvedValueOnce(
      Response.json({ error: { message: "Insufficient permissions" } }, { status: 403 })
    );

    const response = await GET(exportRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Insufficient permissions" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("drops a module the channel leaves out, and its kind, from the API query", async () => {
    request.mockResolvedValueOnce(page(["xfr_1"], null));

    const response = await GET(exportRequest("?module=issuance&kind=mint&status=succeeded"));

    expect(response.status).toBe(200);
    expect(requestedPaths()).toEqual(["/v1/transactions?limit=100&status=succeeded"]);
  });
});
