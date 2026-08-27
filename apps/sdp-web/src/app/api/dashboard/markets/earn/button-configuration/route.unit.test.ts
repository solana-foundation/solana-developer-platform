import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));

vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: mocks.proxyToSdpApi }));

import { PUT } from "./route";

describe("/api/dashboard/markets/earn/button-configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("proxies only the configuration body on save", async () => {
    const request = new Request("https://dashboard.example.test/api/button-configuration", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer browser-token",
        "x-project-id": "project_original",
      },
      body: JSON.stringify({ strategyId: "strategy_1", style: "accent" }),
    });

    await PUT(request);

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.earn.button_configuration.upsert",
      path: "/v1/earn/button-configurations/current",
      expectedProjectId: "project_original",
    });
  });
});
