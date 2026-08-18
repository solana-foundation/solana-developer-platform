import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { POST } from "./route";

function tokenActionRequest(): Request {
  return new Request("https://dashboard.example.com/api/dashboard/issuance/tokens/tok_1/mint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mint: { destination: "dest", amount: "1" } }),
  });
}

describe("POST /api/dashboard/issuance/tokens/[tokenId]/[action]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["not-a-real-action", "__proto__", "constructor", "toString"])(
    "returns 404 for unsupported action %s without proxying",
    async (action) => {
      const response = await POST(tokenActionRequest(), {
        params: Promise.resolve({ tokenId: "tok_1", action }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { message: "Token action is not supported" },
      });
      expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["deploy", "deploy"],
    ["mint", "mint"],
    ["burn", "burn"],
    ["seize", "seize"],
    ["force-burn", "force-burn"],
    ["authority", "authority"],
    ["freeze", "freeze"],
    ["unfreeze", "unfreeze"],
    ["pause", "pause"],
    ["unpause", "unpause"],
    ["refresh-supply", "supply/refresh"],
  ])("proxies action %s to /v1/issuance/tokens/:tokenId/%s", async (action, sdpApiSegment) => {
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
    const request = tokenActionRequest();

    await POST(request, { params: Promise.resolve({ tokenId: "tok_1", action }) });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: `route.dashboard.issuance.token.${action}`,
      path: `/v1/issuance/tokens/tok_1/${sdpApiSegment}`,
    });
  });
});
