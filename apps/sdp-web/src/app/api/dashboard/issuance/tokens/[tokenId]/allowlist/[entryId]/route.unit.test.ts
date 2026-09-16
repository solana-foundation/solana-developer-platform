import { describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: proxy }));

import { DELETE } from "./route";

describe("allowlist removal proxy", () => {
  it.each([
    ["", ""],
    ["?signingCustodyWalletId=cwlt_b&ignored=1", "?signingCustodyWalletId=cwlt_b"],
    ["?signingCustodyWalletId=", "?signingCustodyWalletId="],
  ])("preserves the exact selector from %s", async (query, expected) => {
    const request = new Request(`https://dashboard.example.com/allowlist/entry${query}`, {
      method: "DELETE",
    });
    await DELETE(request, { params: Promise.resolve({ tokenId: "tok_1", entryId: "tal_1" }) });
    expect(proxy).toHaveBeenLastCalledWith({
      request,
      traceSource: "route.dashboard.issuance.token.allowlist.remove",
      path: `/v1/issuance/tokens/tok_1/allowlist/tal_1${expected}`,
    });
  });
});
