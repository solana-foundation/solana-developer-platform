import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";

const mocks = vi.hoisted(() => ({ getSdpAuth: vi.fn() }));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/sdp-auth", () => ({ getSdpAuth: mocks.getSdpAuth }));

import { GET } from "./route";

function linkedRequest(headers: Record<string, string>): Request {
  return new Request("http://dashboard.local/api/dashboard/organizations/linked", { headers });
}

describe("GET /api/dashboard/organizations/linked", () => {
  let readOrganizationLinked: MockInstance<typeof sdpApi.readOrganizationLinked>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_test", orgId: "org_prod" });
    readOrganizationLinked = vi.spyOn(sdpApi, "readOrganizationLinked");
  });

  it("answers whether SDP links the organization the bearer token names", async () => {
    readOrganizationLinked.mockResolvedValue(false);

    const response = await GET(linkedRequest({ authorization: "Bearer token_beta" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ linked: false });
    expect(readOrganizationLinked).toHaveBeenCalledWith("token_beta");
  });

  it("refuses a caller who is not signed in", async () => {
    mocks.getSdpAuth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(linkedRequest({ authorization: "Bearer token_beta" }));

    expect(response.status).toBe(401);
    expect(readOrganizationLinked).not.toHaveBeenCalled();
  });

  it("refuses a request with no organization token", async () => {
    const response = await GET(linkedRequest({}));

    expect(response.status).toBe(400);
    expect(readOrganizationLinked).not.toHaveBeenCalled();
  });
});
