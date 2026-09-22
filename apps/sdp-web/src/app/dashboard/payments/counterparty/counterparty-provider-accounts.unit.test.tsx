import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { CounterpartyProviderAccount } from "@sdp/types";
import { groupProviderAccounts, ProviderWalletBalanceCell } from "./counterparty-detail-workspace";

function providerAccount(
  overrides: Partial<CounterpartyProviderAccount>
): CounterpartyProviderAccount {
  return {
    id: "cpa_1",
    provider: "bvnk",
    kind: "payout_account",
    fiatCurrency: "USD",
    destinationCountry: "US",
    paymentRail: "ACH",
    status: "active",
    providerStatus: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupProviderAccounts", () => {
  it("groups funding-wallet rows per provider with the customer link lifted onto the group", () => {
    const groups = groupProviderAccounts([
      providerAccount({
        id: "cpa_funding",
        kind: "funding_wallet",
        fiatCurrency: "USD",
        destinationCountry: null,
        paymentRail: null,
        providerStatus: "provisioned_funding_wallet",
        providerAccountReference: "a:26091815750755:c1aVEgc:1",
        balance: { state: "available", amount: "9.90", currency: "USD" },
        customerLink: {
          provider: "bvnk",
          id: "cpa_link",
          providerCustomerReference: "cust-1",
          status: "active",
          providerStatus: "ACTIVE",
          createdAt: "2026-01-01T00:00:00.000Z",
          residenceCountryCode: "US",
          agreements: [],
        },
      }),
      providerAccount({
        id: "cpa_payout",
        provider: "lightspark",
        providerStatus: "ACTIVE",
      }),
    ]);

    expect(groups).toHaveLength(2);
    const bvnk = groups.find((group) => group.provider === "bvnk");
    expect(bvnk?.fundingWallets.map((account) => account.id)).toEqual(["cpa_funding"]);
    expect(bvnk?.payoutAccounts).toEqual([]);
    expect(bvnk?.customerLink?.provider).toBe("bvnk");
    const lightspark = groups.find((group) => group.provider === "lightspark");
    expect(lightspark?.payoutAccounts.map((account) => account.id)).toEqual(["cpa_payout"]);
    expect(lightspark?.fundingWallets).toEqual([]);
  });

  it("throws when a funding-wallet account carries no fiat currency, naming the account", () => {
    expect(() =>
      groupProviderAccounts([
        providerAccount({
          id: "cpa_funding_null_fiat",
          kind: "funding_wallet",
          fiatCurrency: null,
        }),
      ])
    ).toThrow("Funding wallet cpa_funding_null_fiat has no fiat currency");
  });
});

describe("ProviderWalletBalanceCell", () => {
  it("renders the available balance with its currency", () => {
    const markup = renderToStaticMarkup(
      <ProviderWalletBalanceCell
        balance={{ state: "available", amount: "9.90", currency: "USD" }}
      />
    );

    expect(markup).toContain("9.90 USD");
  });

  it("renders a muted badge when the balance is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ProviderWalletBalanceCell balance={{ state: "unavailable" }} />
    );

    expect(markup).toContain("DashboardPayments.counterparty.providerAccountBalanceUnavailable");
  });

  it("renders an em dash while no provider wallet exists yet", () => {
    const markup = renderToStaticMarkup(<ProviderWalletBalanceCell balance={undefined} />);

    expect(markup).toContain("—");
  });
});
