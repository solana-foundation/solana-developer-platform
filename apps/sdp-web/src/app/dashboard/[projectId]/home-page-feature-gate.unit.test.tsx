import type { SdpModule } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authMock,
  createSdpApiClientMock,
  channelMock,
  newDesignMock,
  fetchPaymentsAggregateMock,
  fetchPaymentsIssuedTokenSymbolsMock,
  fetchPaymentsWalletsMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createSdpApiClientMock: vi.fn(),
  channelMock: vi.fn<(module: SdpModule) => boolean>(),
  newDesignMock: vi.fn(),
  fetchPaymentsAggregateMock: vi.fn(),
  fetchPaymentsIssuedTokenSymbolsMock: vi.fn(),
  fetchPaymentsWalletsMock: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: authMock }));
vi.mock("@/flags", () => ({
  newDesign: newDesignMock,
  // Each design module's own flag; the Overview's follows NEW DESIGN here.
  newDesignActivity: async () => true,
  newDesignContacts: async () => true,
  newDesignOverview: async () => true,
  newDesignPayDeposit: async () => true,
  newDesignWallets: async () => true,
}));
vi.mock("@/flags/release-channel", () => ({ isModuleInDeploymentReleaseChannel: channelMock }));
vi.mock("@/i18n/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: createSdpApiClientMock }));
vi.mock("./payments/payments-page.data", () => ({
  fetchPaymentsAggregate: fetchPaymentsAggregateMock,
  fetchPaymentsIssuedTokenSymbols: fetchPaymentsIssuedTokenSymbolsMock,
  fetchPaymentsWallets: fetchPaymentsWalletsMock,
}));

import DashboardPage from "./(home)/page";

async function renderPage() {
  // SAFETY: the page is an async server component; its element is read only for the props it passes on.
  const page = (await DashboardPage({})) as { props: Record<string, unknown> } | null;
  if (!page) throw new Error("Expected the home workspace");
  return page;
}

// The Overview (NEW DESIGN) and the previous design's Home read their data the same way.
describe.each([
  ["the Overview", true],
  ["the previous Home", false],
])("dashboard home module flags, %s", (_design, newDesign) => {
  beforeEach(() => {
    authMock.mockReset();
    createSdpApiClientMock.mockReset();
    channelMock.mockReset();
    newDesignMock.mockReset();
    fetchPaymentsAggregateMock.mockReset();
    fetchPaymentsIssuedTokenSymbolsMock.mockReset();
    fetchPaymentsWalletsMock.mockReset();
    authMock.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
    newDesignMock.mockResolvedValue(newDesign);
  });

  it("does not load wallet or issuance data when the release channel leaves Custody out", async () => {
    channelMock.mockImplementation((module) => module !== "custody" && module !== "issuance");

    const page = await renderPage();

    expect(createSdpApiClientMock).not.toHaveBeenCalled();
    expect(page.props).toMatchObject({
      wallets: [],
      balances: [],
      walletCount: 0,
      issuedTokens: [],
    });
  });

  it("does not load issuance token metadata when the release channel leaves Issuance out", async () => {
    channelMock.mockImplementation((module) => module !== "issuance");
    createSdpApiClientMock.mockResolvedValue({ request: vi.fn() });
    fetchPaymentsAggregateMock.mockResolvedValue({ ok: true, data: { balances: [] } });
    fetchPaymentsWalletsMock.mockResolvedValue({ ok: true, data: [] });

    const page = await renderPage();

    expect(fetchPaymentsIssuedTokenSymbolsMock).not.toHaveBeenCalled();
    expect(page.props.issuedTokens).toEqual([]);
  });
});
