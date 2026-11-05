import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));

import { GET } from "./route";

describe("GET /api/dashboard/payments/recurring-payments/[id]/collection-attempts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("reads the schedule's runs page from the SDP API", async () => {
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/payments/recurring-payments/prp_1/collection-attempts?page=1&pageSize=25"
    );

    await GET(request, { params: Promise.resolve({ recurringPaymentId: "prp_1" }) });

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.recurring-payments.collection-attempts.list",
      path: "/v1/payments/recurring-payments/prp_1/collection-attempts?page=1&pageSize=25",
    });
  });
});
