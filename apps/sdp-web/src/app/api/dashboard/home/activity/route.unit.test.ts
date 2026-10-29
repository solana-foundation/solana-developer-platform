import type { TokenTransactionListItem } from "@sdp/types/tokens";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as homePageData from "@/app/dashboard/[projectId]/home-page.data";

const mocks = vi.hoisted(() => ({
  issuance: vi.fn(),
  fetchDashboardPaymentTransfers: vi.fn(),
  fetchPaymentsIssuedTokenSymbols: vi.fn(),
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/flags", () => ({ issuance: mocks.issuance }));
vi.mock("@/app/dashboard/[projectId]/payments/payments-page.data", () => ({
  fetchDashboardPaymentTransfers: mocks.fetchDashboardPaymentTransfers,
  fetchPaymentsIssuedTokenSymbols: mocks.fetchPaymentsIssuedTokenSymbols,
  WALLET_TRANSFERS_DEADLINE_MS: 2_500,
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

const TODAY = "2026-10-23T09:00:00.000Z";
const YESTERDAY = "2026-10-22T09:00:00.000Z";

/** A transfer with the fields the row builder and the volume read. */
function transfer(id: string, createdAt: string, amount: string) {
  return { id, createdAt, amount, status: "completed", direction: "outbound", destination: "D" };
}

const LISTED_MINT: TokenTransactionListItem = {
  token: { id: "tok_acme", name: "Acme", symbol: "ACME", mintAddress: "mint_1" },
  transaction: {
    id: "ttx_1",
    tokenId: "tok_acme",
    organizationId: "org_1",
    type: "mint",
    status: "confirmed",
    idempotencyKey: null,
    idempotencyFingerprint: null,
    signature: "sig_1",
    serializedTx: null,
    params: { amount: "5", destination: "D" },
    slot: null,
    blockTime: null,
    fee: null,
    error: null,
    initiatedByKeyId: null,
    createdAt: TODAY,
    updatedAt: TODAY,
  },
};

describe("GET /api/dashboard/home/activity", () => {
  let buildHomeActivityRows: MockInstance<typeof homePageData.buildHomeActivityRows>;
  let fetchOrgIssuanceActivity: MockInstance<typeof homePageData.fetchOrgIssuanceActivity>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    buildHomeActivityRows = vi.spyOn(homePageData, "buildHomeActivityRows");
    fetchOrgIssuanceActivity = vi.spyOn(homePageData, "fetchOrgIssuanceActivity");
    mocks.issuance.mockResolvedValue(false);
    mocks.createSdpApiClient.mockResolvedValue({ request: vi.fn() });
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [],
      walletsNotLoaded: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not request or return issuance data while Issuance is disabled", async () => {
    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));

    expect(response.status).toBe(200);
    expect(fetchOrgIssuanceActivity).not.toHaveBeenCalled();
    expect(mocks.fetchPaymentsIssuedTokenSymbols).not.toHaveBeenCalled();
    expect(buildHomeActivityRows).toHaveBeenCalledWith([], [], expect.any(Function), {});
  });

  it("includes issuance activity and token metadata while Issuance is enabled", async () => {
    mocks.issuance.mockResolvedValue(true);
    fetchOrgIssuanceActivity.mockResolvedValue({ ok: true, data: [LISTED_MINT] });
    mocks.fetchPaymentsIssuedTokenSymbols.mockResolvedValue({
      ok: true,
      data: [{ mintAddress: "mint_1", symbol: "ACME" }],
    });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchOrgIssuanceActivity).toHaveBeenCalledOnce();
    expect(mocks.fetchPaymentsIssuedTokenSymbols).toHaveBeenCalledOnce();
    expect(buildHomeActivityRows).toHaveBeenCalledWith([], [LISTED_MINT], expect.any(Function), {
      mint_1: "ACME",
    });
    expect(body.data.activityRows).toMatchObject([
      { id: "issuance-ttx_1", token: "ACME", amount: "5", sourceKind: "issuance" },
    ]);
  });

  it("reports unavailable activity sources without fabricating rows", async () => {
    mocks.issuance.mockResolvedValue(true);
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({ ok: false, data: null });
    fetchOrgIssuanceActivity.mockResolvedValue({ ok: false, error: "issuance down" });
    mocks.fetchPaymentsIssuedTokenSymbols.mockResolvedValue({ ok: false, data: null });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data.activityRows).toEqual([]);
    expect(body.data.activityError).toBe("Shared.homeWorkspace.paymentsActivityUnavailable");
    expect(body.data.activityNotice).toContain("Shared.homeWorkspace.issuanceActivityUnavailable");
  });

  it("says the list is partial when some wallets did not load, without an error", async () => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [transfer("transfer_1", TODAY, "12.5")],
      walletsNotLoaded: 1,
    });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data.activityRows).toHaveLength(1);
    expect(body.data.activityError).toBeNull();
    expect(body.data.activityNotice).toBe("Shared.homeWorkspace.somePaymentsActivityUnavailable");
    // Home is the caller that can say the list is partial, so it is the one that sets a deadline.
    expect(mocks.fetchDashboardPaymentTransfers).toHaveBeenCalledWith(expect.anything(), 20, {
      walletDeadlineMs: 2_500,
    });
  });

  it("totals today's volume from the list's own read once every wallet loaded", async () => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [transfer("transfer_1", TODAY, "125"), transfer("transfer_2", YESTERDAY, "50")],
      walletsNotLoaded: 0,
    });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(mocks.fetchDashboardPaymentTransfers).toHaveBeenCalledOnce();
    expect(body.data.activityRows).toHaveLength(2);
    expect(body.data).toMatchObject({ todaysVolume: 125, todaysVolumeError: null });
  });

  // The list can say it is partial; a total cannot, since a sum over some wallets is smaller.
  it.each([
    [
      "a wallet failed or missed its deadline",
      { ok: true, data: [transfer("transfer_1", TODAY, "125")], walletsNotLoaded: 1 },
    ],
    [
      "the wallet list failed",
      { ok: true, data: [transfer("transfer_1", TODAY, "125")], walletsNotLoaded: null },
    ],
    ["the transfers read failed", { ok: false, data: null, walletsNotLoaded: 0 }],
  ])("reports the volume unavailable, not understated, when %s", async (_label, result) => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue(result);

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data).toMatchObject({
      todaysVolume: null,
      todaysVolumeError: "Shared.homeWorkspace.paymentsActivityUnavailable",
    });
  });

  it("reports activity unavailable, not empty, when no wallet loaded and nothing else did", async () => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [],
      walletsNotLoaded: 2,
    });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data.activityRows).toEqual([]);
    expect(body.data.activityError).toBe("Shared.homeWorkspace.paymentsActivityUnavailable");
  });

  // The wallet list itself failed, so this is persisted history only and how
  // many wallets are missing is unknown.
  it("says the list is partial when the wallet list failed", async () => {
    mocks.fetchDashboardPaymentTransfers.mockResolvedValue({
      ok: true,
      data: [transfer("transfer_1", TODAY, "12.5")],
      walletsNotLoaded: null,
    });

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(body.data.activityNotice).toBe("Shared.homeWorkspace.somePaymentsActivityUnavailable");
  });

  it("returns a traced 500 when the dashboard client cannot be created", async () => {
    mocks.createSdpApiClient.mockRejectedValue(new Error("client unavailable"));

    const response = await GET(new Request("http://localhost/api/dashboard/home/activity"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("client unavailable");
  });
});
