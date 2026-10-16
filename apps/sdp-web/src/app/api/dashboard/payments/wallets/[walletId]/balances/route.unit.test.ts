import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);

import { GET } from "./route";

describe("wallet balance confirmation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null));
  });
  it("preserves the slot bound through the dashboard proxy", async () => {
    const request = new Request("https://dashboard.example.test/balances?minimumSlot=101");
    await GET(request, { params: Promise.resolve({ walletId: "wallet/one" }) });
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/payments/wallets/wallet%2Fone/balances?minimumSlot=101",
      })
    );
  });
  it.each(["-1", "01", "1.5", "9007199254740992", "1&minimumSlot=2"])(
    "rejects invalid minimumSlot %s before forwarding",
    async (value) => {
      const response = await GET(
        new Request(`https://dashboard.example.test/balances?minimumSlot=${value}`),
        { params: Promise.resolve({ walletId: "wallet" }) }
      );
      expect(response.status).toBe(400);
      expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
    }
  );
});
