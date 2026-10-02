import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET } from "./route";

function get(query: string) {
  return GET(new Request(`https://dashboard.example.test/api/dashboard/approval-requests${query}`));
}

function forwardedPath(): string {
  return mocks.proxyToSdpApi.mock.calls[0]?.[0].path;
}

describe("GET /api/dashboard/approval-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards the status, limit, cursor and viewer filter the API knows", async () => {
    await get("?status=pending&limit=100&viewerCanDecide=true&cursor=MjAyNi0wOS0yNXxhcHByXzE");

    expect(forwardedPath()).toBe(
      "/v1/wallets/approval-requests?status=pending&limit=100&cursor=MjAyNi0wOS0yNXxhcHByXzE&viewerCanDecide=true"
    );
  });

  it("drops values the API would refuse", async () => {
    await get("?status=weird&limit=1000&viewerCanDecide=yes&cursor=not%20a%20cursor%21");

    expect(forwardedPath()).toBe("/v1/wallets/approval-requests");
  });
});
