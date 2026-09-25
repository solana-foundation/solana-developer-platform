import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { GET } from "./route";

describe("GET /api/dashboard/approval-requests/:approvalRequestId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("binds the proxy to the project the client declared", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/approval-requests/apr_1",
      { headers: { "x-project-id": "project_mounted" } }
    );

    await GET(request, { params: Promise.resolve({ approvalRequestId: "apr_1" }) });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.approval-requests.detail",
      path: "/v1/wallets/approval-requests/apr_1",
      boundProjectId: "project_mounted",
    });
  });

  it("leaves the project to the shared-cookie resolution when the client declares none", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/approval-requests/apr_1"
    );

    await GET(request, { params: Promise.resolve({ approvalRequestId: "apr_1" }) });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.approval-requests.detail",
      path: "/v1/wallets/approval-requests/apr_1",
      boundProjectId: undefined,
    });
  });
});
