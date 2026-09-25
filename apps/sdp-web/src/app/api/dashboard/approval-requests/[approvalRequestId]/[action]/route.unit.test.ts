import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: mocks.proxyToSdpApi,
}));

import { POST } from "./route";

describe("POST /api/dashboard/approval-requests/:approvalRequestId/:action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("binds the decision to the project the client declared", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/approval-requests/apr_1/approve",
      { method: "POST", headers: { "x-project-id": "project_mounted" } }
    );

    await POST(request, {
      params: Promise.resolve({ approvalRequestId: "apr_1", action: "approve" }),
    });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.approval-requests.approve",
      path: "/v1/wallets/approval-requests/apr_1/approve",
      boundProjectId: "project_mounted",
    });
  });

  it("leaves the project to the shared-cookie resolution when the client declares none", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/approval-requests/apr_1/approve",
      { method: "POST" }
    );

    await POST(request, {
      params: Promise.resolve({ approvalRequestId: "apr_1", action: "approve" }),
    });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.approval-requests.approve",
      path: "/v1/wallets/approval-requests/apr_1/approve",
      boundProjectId: undefined,
    });
  });

  it("refuses an unsupported action without proxying", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/approval-requests/apr_1/escalate",
      { method: "POST", headers: { "x-project-id": "project_mounted" } }
    );

    const response = await POST(request, {
      params: Promise.resolve({ approvalRequestId: "apr_1", action: "escalate" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
