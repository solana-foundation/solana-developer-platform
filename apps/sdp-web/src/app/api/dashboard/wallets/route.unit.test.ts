import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sdp-api")>("@/lib/sdp-api");
  return {
    ...actual,
    proxyToSdpApi: mocks.proxyToSdpApi,
  };
});

import { GET } from "./route";

// SOLA9-564: a surface presenting a rendered project context (the token
// detail's signer inventory) gets its wallets from exactly that project,
// while requests without a context keep the cookie-based resolution.
describe("GET /api/dashboard/wallets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: { wallets: [] } }));
  });

  it("binds the request to the rendered project context when presented", async () => {
    const request = new Request(
      "https://dashboard.example.com/api/dashboard/wallets?view=summary",
      {
        headers: { "x-sdp-project-context": "project_rendered" },
      }
    );

    await GET(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledOnce();
    expect(mocks.proxyToSdpApi.mock.calls[0]?.[0]).toMatchObject({
      boundProjectId: "project_rendered",
      path: "/v1/wallets?view=summary&includeAllProviders=true",
    });
  });

  it("keeps the cookie-based resolution when no context is presented", async () => {
    await GET(new Request("https://dashboard.example.com/api/dashboard/wallets"));

    expect(mocks.proxyToSdpApi.mock.calls[0]?.[0]).toMatchObject({
      boundProjectId: null,
    });
  });
});
