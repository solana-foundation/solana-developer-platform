import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  assetProfiles: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/flags", () => ({ assetProfiles: mocks.assetProfiles }));
vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    childContext: () => undefined,
    log: () => undefined,
    step: (_name: string, task: () => unknown) => task(),
  }),
}));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: mocks.createSdpApiClient }));

import { GET } from "./route";

describe("GET /api/dashboard/issuance/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetProfiles.mockResolvedValue(false);
    mocks.apiRequest.mockResolvedValue(
      Response.json({ data: [], meta: { total: 0, page: 1, pageSize: 24, hasMore: false } })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request: mocks.apiRequest });
  });

  it("round-trips the exact Smoky SQL-shaped unicode search as a 200 empty page", async () => {
    const search = "qa-no-match-' OR 1=1 -- 🚀";
    const url = new URL("https://dashboard.example.test/api/dashboard/issuance/tokens");
    url.searchParams.set("searchEncoded", "cWEtbm8tbWF0Y2gtJyBPUiAxPTEgLS0g8J-agA");

    const response = await GET(new Request(url));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      total: 0,
      page: 1,
      pageSize: 24,
      hasMore: false,
      error: null,
    });
    expect(mocks.apiRequest).toHaveBeenCalledOnce();
    const [path] = mocks.apiRequest.mock.calls[0] as [string];
    expect(new URL(path, "https://api.example.test").searchParams.get("search")).toBe(search);
  });
});
