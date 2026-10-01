import { describe, expect, it, vi } from "vitest";
import { loadWalletActivity } from "./wallet-activity.data";

describe("loadWalletActivity", () => {
  it("uses the exact wallet identity for Payments and Issuance", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/v1/payments/transfers?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await loadWalletActivity(
      request,
      { custodyWalletId: "cwlt_1", providerWalletId: "privy_1" },
      ((key: string) => key) as Parameters<typeof loadWalletActivity>[2]
    );

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/issuance/transactions?custodyWalletId=cwlt_1&page=1&pageSize=20",
    ]);
  });
});

describe("loadWalletActivity windows", () => {
  const t = ((key: string) => key) as Parameters<typeof loadWalletActivity>[2];
  const wallet = { custodyWalletId: "cwlt_1", providerWalletId: "privy_1" };

  function transfer(index: number) {
    return {
      id: `xfr_${index}`,
      custodyWalletId: "cwlt_1",
      providerWalletId: "privy_1",
      rampsMemo: {},
      status: "finalized",
      direction: "outbound",
      createdAt: new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString(),
    };
  }

  function requestWith(transferCount: number, issuanceCount: number) {
    return vi.fn(async (path: string) => {
      const query = new URL(path, "https://api.example.com").searchParams;
      const page = Number(query.get("page"));
      const pageSize = Number(query.get("pageSize"));
      const start = (page - 1) * pageSize;
      if (path.startsWith("/v1/payments/transfers?")) {
        const rows = Array.from(
          { length: Math.max(0, Math.min(pageSize, transferCount - start)) },
          (_, offset) => transfer(start + offset)
        );
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      const rows = Array.from({ length: Math.min(pageSize, issuanceCount) }, (_, index) => ({
        token: { symbol: "TKN", name: "Token" },
        transaction: {
          id: `itx_${index}`,
          type: "mint",
          status: "confirmed",
          signature: null,
          params: {},
          createdAt: new Date(Date.UTC(2026, 7, 1) - index * 60_000).toISOString(),
        },
      }));
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    });
  }

  it("reads a window wider than a transfers page across parallel pages of 100", async () => {
    const request = requestWith(250, 3);

    const result = await loadWalletActivity(request, wallet, t, { pageSize: 220 });

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/payments/transfers?page=2&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/payments/transfers?page=3&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/issuance/transactions?custodyWalletId=cwlt_1&page=1&pageSize=220",
    ]);
    const rows = result.data?.activityRows ?? [];
    expect(rows).toHaveLength(220);
    expect(rows[0]?.id).toBe("payment-xfr_0");
    expect(rows[219]?.id).toBe("payment-xfr_219");
    expect(result.data?.hasMore).toBe(true);
  });

  it("reports older rows while a source fills the window or the merge drops rows", async () => {
    const full = await loadWalletActivity(requestWith(20, 0), wallet, t);
    expect(full.data?.hasMore).toBe(true);

    const merged = await loadWalletActivity(requestWith(15, 10), wallet, t);
    expect(merged.data?.activityRows).toHaveLength(20);
    expect(merged.data?.hasMore).toBe(true);

    const complete = await loadWalletActivity(requestWith(12, 3), wallet, t);
    expect(complete.data?.activityRows).toHaveLength(15);
    expect(complete.data?.hasMore).toBe(false);
  });

  it("fails the transfers source as a whole when any of its pages fails", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("page=2&")) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await loadWalletActivity(request, wallet, t, { pageSize: 150 });

    expect(result.data?.activityRows).toEqual([]);
    expect(result.data?.activityNotice).toBe("DashboardCustody.paymentsActivityUnavailable");
    expect(result.data?.hasMore).toBe(false);
  });
});
