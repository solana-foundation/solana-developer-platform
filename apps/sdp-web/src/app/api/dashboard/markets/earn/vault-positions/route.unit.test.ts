import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET } from "./route";

describe("GET /api/dashboard/markets/earn/vault-positions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards the bounded allowlisted keyset query", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/vault-positions?before=abc_DEF-123&limit=100"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.vault_positions.list",
      path: "/v1/earn/vault-positions?limit=100&before=abc_DEF-123",
    });
  });

  it("forwards confirmation movement ids to the authenticated positions API", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/vault-positions?afterMovementIds=earn_one,earn_two"
    );
    await GET(request);
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v1/earn/vault-positions?afterMovementIds=earn_one%2Cearn_two",
      })
    );
  });

  it.each([
    "?afterMovementIds=",
    "?afterMovementIds=one,,two",
    "?afterMovementIds=one&afterMovementIds=two",
    `?afterMovementIds=${Array.from({ length: 101 }, (_, i) => `movement_${i}`).join(",")}`,

    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=20&limit=30",
    "?before=",
    `?before=${"a".repeat(513)}`,
    "?before=not%2Fa%2Bbase64url%3Dcursor",
    "?page=2",
  ])("rejects malformed or non-allowlisted query %s", async (query) => {
    const response = await GET(
      new Request(`https://dashboard.example.test/api/vault-positions${query}`)
    );

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
