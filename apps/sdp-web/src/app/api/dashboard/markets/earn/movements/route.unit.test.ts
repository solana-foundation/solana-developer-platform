import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET } from "./route";

describe("GET /api/dashboard/markets/earn/movements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("forwards the bounded allowlisted query, filters included", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/movements?limit=50&before=abc_DEF-123" +
        "&direction=deposit&status=finalized&provider=kamino" +
        "&positionId=earn_position_1&sourceAddress=Depositor1&destinationAddress=Vault1"
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.movements.list",
      path:
        "/v1/earn/movements?limit=50&before=abc_DEF-123&direction=deposit" +
        "&status=finalized&provider=kamino&positionId=earn_position_1" +
        "&sourceAddress=Depositor1&destinationAddress=Vault1",
    });
  });

  it("forwards an unfiltered request as a bare path", async () => {
    const request = new Request("https://dashboard.example.test/api/movements");

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.movements.list",
      path: "/v1/earn/movements",
    });
  });

  it.each([
    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=20&limit=30",
    "?before=",
    `?before=${"a".repeat(513)}`,
    "?before=not%2Fa%2Bbase64url%3Dcursor",
    // Not the ledger's vocabulary: `withdraw` is migration 0059's spelling, which
    // the unified feed deliberately does not use.
    "?direction=withdraw",
    "?direction=Deposit",
    "?status=",
    `?status=${"s".repeat(65)}`,
    `?provider=${"p".repeat(65)}`,
    `?positionId=${"p".repeat(129)}`,
    "?sourceAddress=has%20a%20space",
    "?destinationAddress=semi%3Bcolon",
    // Never allowlisted: an internal correlation value, not a description of money.
    "?requestId=abc",
    "?page=2",
  ])("rejects malformed or non-allowlisted query %s", async (query) => {
    const response = await GET(new Request(`https://dashboard.example.test/api/movements${query}`));

    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
