import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeTodaysVolume: vi.fn(() => 0),
  fetchDashboardPaymentTransfers: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/app/dashboard/home-page.data", () => ({
  computeTodaysVolume: mocks.computeTodaysVolume,
}));
vi.mock("@/app/dashboard/payments/payments-page.data", () => ({
  fetchDashboardPaymentTransfers: mocks.fetchDashboardPaymentTransfers,
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

const request = () => new Request("http://localhost/api/dashboard/home/volume");

describe("GET /api/dashboard/home/volume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue({ request: vi.fn() });
  });

  // The list drops a slow wallet; a total cannot, so this read waits on all of them.
  it("waits on every wallet and reports today's volume", async () => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [{ id: "transfer_1" }],
      walletsNotLoaded: 0,
    });
    mocks.computeTodaysVolume.mockReturnValueOnce(125);

    const body = await (await GET(request())).json();

    expect(mocks.fetchDashboardPaymentTransfers).toHaveBeenCalledWith(expect.anything(), 20);
    expect(body.data).toEqual({ todaysVolume: 125, todaysVolumeError: null });
  });

  it.each([
    ["a wallet read failed", { ok: true, data: [{ id: "transfer_1" }], walletsNotLoaded: 1 }],
    ["the wallet list failed", { ok: true, data: [{ id: "transfer_1" }], walletsNotLoaded: null }],
    ["the transfers read failed", { ok: false, data: null, walletsNotLoaded: 0 }],
  ])("reports the volume unavailable, not understated, when %s", async (_label, result) => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue(result);

    const body = await (await GET(request())).json();

    expect(body.data).toEqual({
      todaysVolume: null,
      todaysVolumeError: "Shared.homeWorkspace.paymentsActivityUnavailable",
    });
    expect(mocks.computeTodaysVolume).not.toHaveBeenCalled();
  });

  it("returns a traced 500 when the dashboard client cannot be created", async () => {
    mocks.createSdpApiClient.mockRejectedValue(new Error("client unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("client unavailable");
  });
});
