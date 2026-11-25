import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { GET } from "./route";

const params = (walletId: string) => ({ params: Promise.resolve({ walletId }) });

describe("GET /api/dashboard/payments/wallets/[walletId]/balances", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the slot the balances must be read at, under the encoded wallet id", async () => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }));
    const request = new Request("https://dashboard.example.test/balances?minimumSlot=101");

    await GET(request, params("wallet/one"));

    expect(proxy).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.wallets.balances.get",
      path: "/v1/payments/wallets/wallet%2Fone/balances?minimumSlot=101",
    });
  });

  it.each(["1.5", "9007199254740992", "1&minimumSlot=2"])(
    "rejects minimumSlot=%s before forwarding",
    async (value) => {
      const proxy = vi.spyOn(sdpApi, "proxyToSdpApi");

      const response = await GET(
        new Request(`https://dashboard.example.test/balances?minimumSlot=${value}`),
        params("wallet")
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { message: "Invalid wallet balance minimumSlot" },
      });
      expect(proxy).not.toHaveBeenCalled();
    }
  );
});
