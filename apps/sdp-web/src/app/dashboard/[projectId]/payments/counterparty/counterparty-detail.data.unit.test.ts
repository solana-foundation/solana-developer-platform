import type { PaymentTransferSummary } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchCounterpartyDetail, fetchCounterpartyPayouts } from "./counterparty-detail.data";

function transfer(id: string): PaymentTransferSummary {
  return {
    id,
    custodyWalletId: null,
    providerWalletId: "pw_1",
    status: "completed",
    signature: null,
    direction: "outbound",
    token: "USDC",
    amount: "1",
    rampsMemo: {},
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers the payouts read with `total` payouts in pages of 100; `failPage` answers 500. */
function payoutsApi(total: number, failPage?: number) {
  return vi.fn<SdpApiClient["request"]>(async (path) => {
    const query = new URL(path, "http://api.test").searchParams;
    const page = Number(query.get("page"));
    if (page === failPage) return json({}, 500);
    const start = (page - 1) * 100;
    const ids = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, index) =>
      transfer(`tx_${start + index}`)
    );
    return json({ data: ids, meta: { total } });
  });
}

describe("fetchCounterpartyPayouts", () => {
  it("asks for the contact's settled outbound transfers only", async () => {
    const request = payoutsApi(3);
    await fetchCounterpartyPayouts(request, "cpty_test");
    const query = new URL(request.mock.calls[0]?.[0] ?? "", "http://api.test").searchParams;
    expect(query.get("counterpartyId")).toBe("cpty_test");
    expect(query.get("direction")).toBe("outbound");
    expect(query.get("status")).toBe("completed,confirmed,finalized");
  });

  it("reads past the first page, so older payouts count", async () => {
    const result = await fetchCounterpartyPayouts(payoutsApi(250), "cpty_test");
    expect(result).toMatchObject({ ok: true, total: 250 });
    expect(result.data).toHaveLength(250);
  });

  it("stops at the cap and keeps the full count", async () => {
    const request = payoutsApi(900);
    const result = await fetchCounterpartyPayouts(request, "cpty_test", 200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, total: 900 });
    expect(result.data).toHaveLength(200);
  });

  it("keeps the pages read before one failed and reports the failure", async () => {
    const result = await fetchCounterpartyPayouts(payoutsApi(250, 2), "cpty_test");
    expect(result).toMatchObject({ ok: false, total: 250 });
    expect(result.data).toHaveLength(100);
  });

  it("reports a failed first page as nothing read", async () => {
    const result = await fetchCounterpartyPayouts(payoutsApi(250, 1), "cpty_test");
    expect(result).toEqual({ ok: false, data: [], total: 0 });
  });
});

describe("fetchCounterpartyDetail", () => {
  it("says when the contact's addresses could not be read", async () => {
    const request = vi.fn<SdpApiClient["request"]>(async (path) =>
      path.includes("/accounts") ? json({}, 500) : json({ data: [] })
    );
    const detail = await fetchCounterpartyDetail(request, "cpty_test");
    expect(detail).toMatchObject({ accounts: [], accountsFailed: true });
  });
});
