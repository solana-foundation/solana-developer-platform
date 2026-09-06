import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, custodyMock, fetchMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  custodyMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: authMock }));
vi.mock("@/flags", () => ({ custody: custodyMock }));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock }),
}));

import PoliciesPage from "./page";

describe("policies custody boundary", () => {
  beforeEach(() => {
    authMock.mockReset();
    custodyMock.mockReset();
    fetchMock.mockReset();
    authMock.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
    fetchMock.mockResolvedValue({ controls: [], page: 1, pageSize: 25, total: 0 });
  });

  it("loads only API key controls when Custody is disabled", async () => {
    custodyMock.mockResolvedValue(false);

    const page = await PoliciesPage({
      searchParams: Promise.resolve({ tab: "wallets" }),
    });

    expect(fetchMock).toHaveBeenCalledWith("/v1/policies?target=api_key&page=1&pageSize=25");
    expect(page.props).toMatchObject({
      custodyEnabled: false,
      state: { tab: "api_keys" },
    });
  });
});
