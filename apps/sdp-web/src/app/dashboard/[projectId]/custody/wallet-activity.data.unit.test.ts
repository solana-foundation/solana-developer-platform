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
