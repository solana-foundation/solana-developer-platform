import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  loadWalletActivity: vi.fn(),
}));

vi.mock("@/app/dashboard/custody/wallet-activity.data", () => ({
  loadWalletActivity: mocks.loadWalletActivity,
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { GET } from "./route";

describe("GET /api/dashboard/wallets/:walletId/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["invalid JSON", "not JSON"],
    ["a missing custody wallet ID", JSON.stringify({ data: { wallet: { walletId: "privy_1" } } })],
    [
      "an empty custody wallet ID",
      JSON.stringify({ data: { wallet: { id: "  ", walletId: "privy_1" } } }),
    ],
    ["a missing provider wallet ID", JSON.stringify({ data: { wallet: { id: "cwlt_1" } } })],
    [
      "an empty provider wallet ID",
      JSON.stringify({ data: { wallet: { id: "cwlt_1", walletId: "  " } } }),
    ],
  ])("returns 502 without loading activity for %s", async (_case, body) => {
    const apiRequest = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request: apiRequest });

    const response = await GET(
      new Request("https://dashboard.example.com/api/dashboard/wallets/cwlt_1/activity"),
      { params: Promise.resolve({ walletId: "cwlt_1" }) }
    );

    expect(response.status).toBe(502);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(mocks.loadWalletActivity).not.toHaveBeenCalled();
  });
});
