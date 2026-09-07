import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issuance: vi.fn(),
  buildHomeActivityRows: vi.fn((): unknown[] => []),
  computeTodaysVolume: vi.fn(() => 0),
  fetchOrgIssuanceActivity: vi.fn(),
  fetchDashboardPaymentTransfers: vi.fn(),
  fetchPaymentsIssuedTokenSymbols: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/flags", () => ({ issuance: mocks.issuance }));
vi.mock("@/app/dashboard/home-page.data", () => ({
  buildHomeActivityRows: mocks.buildHomeActivityRows,
  computeTodaysVolume: mocks.computeTodaysVolume,
  fetchOrgIssuanceActivity: mocks.fetchOrgIssuanceActivity,
}));
vi.mock("@/app/dashboard/payments/payments-page.data", () => ({
  fetchDashboardPaymentTransfers: mocks.fetchDashboardPaymentTransfers,
  fetchPaymentsIssuedTokenSymbols: mocks.fetchPaymentsIssuedTokenSymbols,
}));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    childContext: () => undefined,
    log: () => undefined,
    serverTiming: () => "",
    step: (_name: string, task: () => unknown) => task(),
    traceId: "trace_test",
  }),
  logRouteResult: () => undefined,
}));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: mocks.createSdpApiClient }));

import { GET } from "./route";

describe("GET /api/dashboard/home/activity feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issuance.mockResolvedValue(false);
    mocks.createSdpApiClient.mockResolvedValue({ request: vi.fn() });
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({ ok: true, data: [] });
  });

  it("does not request or return issuance data while Issuance is disabled", async () => {
    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));

    expect(response.status).toBe(200);
    expect(mocks.fetchOrgIssuanceActivity).not.toHaveBeenCalled();
    expect(mocks.fetchPaymentsIssuedTokenSymbols).not.toHaveBeenCalled();
    expect(mocks.buildHomeActivityRows).toHaveBeenCalledWith([], [], expect.any(Function), {});
  });

  it("includes issuance activity and token metadata while Issuance is enabled", async () => {
    mocks.issuance.mockResolvedValue(true);
    mocks.fetchOrgIssuanceActivity.mockResolvedValue({ ok: true, data: [{ transaction: {} }] });
    mocks.fetchPaymentsIssuedTokenSymbols.mockResolvedValue({
      ok: true,
      data: [{ mintAddress: "mint_1", symbol: "ACME" }],
    });
    mocks.buildHomeActivityRows.mockReturnValueOnce([{ id: "issuance_1", sourceKind: "issuance" }]);

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));

    expect(response.status).toBe(200);
    expect(mocks.fetchOrgIssuanceActivity).toHaveBeenCalledOnce();
    expect(mocks.fetchPaymentsIssuedTokenSymbols).toHaveBeenCalledOnce();
    expect(mocks.buildHomeActivityRows).toHaveBeenCalledWith(
      [],
      [{ transaction: {} }],
      expect.any(Function),
      { mint_1: "ACME" }
    );
  });

  it("reports unavailable activity sources without fabricating rows", async () => {
    mocks.issuance.mockResolvedValue(true);
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({ ok: false, data: null });
    mocks.fetchOrgIssuanceActivity.mockResolvedValue({ ok: false, data: null });
    mocks.fetchPaymentsIssuedTokenSymbols.mockResolvedValue({ ok: false, data: null });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data.activityError).toBe("Shared.homeWorkspace.paymentsActivityUnavailable");
    expect(body.data.activityNotice).toContain("Shared.homeWorkspace.issuanceActivityUnavailable");
  });

  it("returns a traced 500 when the dashboard client cannot be created", async () => {
    mocks.createSdpApiClient.mockRejectedValue(new Error("client unavailable"));

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("client unavailable");
  });
});
