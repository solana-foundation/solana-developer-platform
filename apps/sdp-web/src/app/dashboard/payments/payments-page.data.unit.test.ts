import { describe, expect, it, vi } from "vitest";
import { fetchDashboardPaymentTransfersForWallets } from "./payments-page.data";

describe("fetchDashboardPaymentTransfersForWallets", () => {
  it("reuses preloaded wallets while preserving wallet-scoped transfer history", async () => {
    const request = vi.fn(async (path: string) => {
      const walletId = new URL(`https://example.test${path}`).searchParams.get("wallet");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: `transfer-${walletId}`,
              status: "confirmed",
              signature: `signature-${walletId}`,
              token: "USDC",
              amount: "1",
              createdAt: "2026-07-17T15:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await fetchDashboardPaymentTransfersForWallets(
      request,
      {
        ok: true,
        data: [
          { id: "wallet-row-1", walletId: "wallet-1", publicKey: "address-1", label: null },
          { id: "wallet-row-2", walletId: "wallet-2", publicKey: "address-2", label: null },
        ],
      },
      20
    );

    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&wallet=wallet-1",
      "/v1/payments/transfers?page=1&pageSize=20&wallet=wallet-2",
    ]);
  });
});
