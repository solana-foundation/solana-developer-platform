import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  loadWalletActivity: vi.fn(),
}));

vi.mock("@/app/dashboard/custody/wallet-activity.data", () => ({
  loadWalletActivity: mocks.loadWalletActivity,
  WALLET_ACTIVITY_LIMIT: 20,
  WALLET_ACTIVITY_MAX_LIMIT: 500,
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

  it.each([
    ["no limit", "", 20],
    ["a widened window", "?limit=220", 220],
    ["the largest window", "?limit=500", 500],
    ["a window past the largest", "?limit=501", 20],
    ["a non-numeric limit", "?limit=all", 20],
  ])("reads %s as a window of %s rows", async (_case, search, pageSize) => {
    const apiRequest = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { wallet: { id: "cwlt_1", walletId: "privy_1" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request: apiRequest });
    mocks.loadWalletActivity.mockResolvedValue({
      ok: true,
      data: { activityRows: [], activityError: null, activityNotice: null, hasMore: false },
    });

    const response = await GET(
      new Request(`https://dashboard.example.com/api/dashboard/wallets/cwlt_1/activity${search}`),
      { params: Promise.resolve({ walletId: "cwlt_1" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.loadWalletActivity).toHaveBeenCalledWith(
      apiRequest,
      { custodyWalletId: "cwlt_1", providerWalletId: "privy_1" },
      expect.any(Function),
      { pageSize }
    );
  });
});
