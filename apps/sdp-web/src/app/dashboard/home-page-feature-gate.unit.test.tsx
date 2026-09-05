import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  createSdpApiClientMock,
  custodyMock,
  issuanceMock,
  fetchPaymentsAggregateMock,
  fetchPaymentsIssuedTokenSymbolsMock,
  fetchPaymentsWalletsMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createSdpApiClientMock: vi.fn(),
  custodyMock: vi.fn(),
  issuanceMock: vi.fn(),
  fetchPaymentsAggregateMock: vi.fn(),
  fetchPaymentsIssuedTokenSymbolsMock: vi.fn(),
  fetchPaymentsWalletsMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: authMock }));
vi.mock("@/flags", () => ({ custody: custodyMock, issuance: issuanceMock }));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: createSdpApiClientMock }));
vi.mock("./payments/payments-page.data", () => ({
  fetchPaymentsAggregate: fetchPaymentsAggregateMock,
  fetchPaymentsIssuedTokenSymbols: fetchPaymentsIssuedTokenSymbolsMock,
  fetchPaymentsWallets: fetchPaymentsWalletsMock,
}));

import DashboardPage from "./page";

describe("dashboard home module flags", () => {
  beforeEach(() => {
    authMock.mockReset();
    createSdpApiClientMock.mockReset();
    custodyMock.mockReset();
    issuanceMock.mockReset();
    fetchPaymentsAggregateMock.mockReset();
    fetchPaymentsIssuedTokenSymbolsMock.mockReset();
    fetchPaymentsWalletsMock.mockReset();
    authMock.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
    issuanceMock.mockResolvedValue(false);
  });

  it("does not load wallet or issuance data when Custody is disabled", async () => {
    custodyMock.mockResolvedValue(false);

    const page = await DashboardPage();

    expect(createSdpApiClientMock).not.toHaveBeenCalled();
    expect(page).not.toBeNull();
    if (!page) throw new Error("Expected the feature-gated home workspace");
    expect(page.props).toMatchObject({
      wallets: [],
      balances: [],
      walletCount: 0,
      issuedTokens: [],
    });
  });

  it("does not load issuance token metadata when Issuance is disabled", async () => {
    custodyMock.mockResolvedValue(true);
    createSdpApiClientMock.mockResolvedValue({ request: vi.fn() });
    fetchPaymentsAggregateMock.mockResolvedValue({ ok: true, data: { balances: [] } });
    fetchPaymentsWalletsMock.mockResolvedValue({ ok: true, data: [] });

    const page = await DashboardPage();

    expect(fetchPaymentsIssuedTokenSymbolsMock).not.toHaveBeenCalled();
    expect(page).not.toBeNull();
    if (!page) throw new Error("Expected the Home workspace");
    expect(page.props.issuedTokens).toEqual([]);
  });
});
