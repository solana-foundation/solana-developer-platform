import { BVNK_FUNDING_WALLET_STATUS, type CounterpartyProviderAccount } from "@sdp/types";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/environments";
import {
  CounterpartyDetailWorkspace,
  groupProviderAccounts,
} from "./counterparty-detail-workspace";

vi.mock("@/i18n/provider", () => ({
  useTranslations:
    () =>
    (
      key: string,
      values?: {
        label?: string;
        currency?: string;
      }
    ) =>
      values?.label
        ? `${key} ${values.label}`
        : values?.currency
          ? `${key} ${values.currency}`
          : key,
  useLocale: () => "en",
}));

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
        providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
        providerAccountReference: "a:10000000000002:TESTWLT:1",
        balance: { state: "available", amount: "9.90", currency: "USD" },
        customerLink: {
          provider: "bvnk",
          id: "cpa_link",
          providerCustomerReference: "cust-1",
          status: "active",
          providerStatus: "VERIFIED",
          createdAt: "2026-01-01T00:00:00.000Z",
          residenceCountryCode: "US",
          agreements: [],
        },
      }),
      providerAccount({
        id: "cpa_payout",
        provider: "lightspark",
        providerStatus: "VERIFIED",
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
});

const accountState = vi.hoisted(() => ({ accounts: [] as CounterpartyProviderAccount[] }));
vi.mock("./use-counterparty-provider-accounts", () => ({
  useCounterpartyProviderAccounts: () => ({ data: accountState.accounts, error: undefined }),
}));
describe("counterparty provider wallet card", () => {
  let environment: EnvironmentReturn;
  let root: Root;
  let container: HTMLDivElement;
  beforeAll(async () => {
    environment = await builtinEnvironments.jsdom.setup(globalThis, {
      jsdom: { url: "http://localhost" },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await environment.teardown(globalThis);
  });
  async function renderWallet(account: CounterpartyProviderAccount) {
    accountState.accounts = [account];
    container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () =>
      root.render(
        <CounterpartyDetailWorkspace
          counterparty={{
            id: "cpty_test",
            organizationId: "org_test",
            projectId: "prj_test",
            externalId: null,
            entityType: "individual",
            displayName: "Test Customer",
            status: "active",
            createdBy: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }}
          initialAccounts={[]}
          initialTransfers={[]}
        />
      )
    );
    const toggle = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')
    ).find((button) => button.textContent?.includes("BVNK"));
    if (toggle === undefined) throw new Error("Expected collapsed BVNK provider accordion");
    return toggle;
  }
  function walletAccount(overrides: Partial<CounterpartyProviderAccount>) {
    return providerAccount({
      kind: "funding_wallet",
      destinationCountry: null,
      paymentRail: null,
      providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
      providerAccountReference: "a:10000000000002:TESTWLT:1",
      customerLink: {
        provider: "bvnk",
        id: "cpa_link",
        providerCustomerReference: "00000000-0000-4000-8000-00000000c058",
        status: "active",
        providerStatus: "VERIFIED",
        createdAt: "2026-01-01T00:00:00.000Z",
        residenceCountryCode: "US",
        agreements: [
          {
            name: "test_agreement",
            displayName: "Test Wallet Agreement",
            url: "https://help.bvnk.com/test-agreement",
            privacyPolicyUrl: "https://help.bvnk.com/test-privacy",
            signedAt: null,
          },
        ],
      },
      ...overrides,
    });
  }
  it.each([
    {
      name: "available balance",
      overrides: { balance: { state: "available", amount: "9.90", currency: "USD" } },
      text: "9.90 USD",
      copy: true,
    },
    {
      name: "unavailable balance badge",
      overrides: { balance: { state: "unavailable" } },
      text: "DashboardPayments.counterparty.providerAccountBalanceUnavailable",
      copy: true,
    },
    {
      name: "provisioning em dash",
      overrides: {
        providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
        providerAccountReference: undefined,
        balance: undefined,
      },
      text: "—",
      copy: false,
    },
  ] satisfies Array<{
    name: string;
    overrides: Partial<CounterpartyProviderAccount>;
    text: string;
    copy: boolean;
  }>)("renders $name in the expanded wallet row", async ({ overrides, text, copy }) => {
    const toggle = await renderWallet(walletAccount(overrides));
    expect(container.textContent).not.toContain("Test Wallet Agreement");
    expect(container.querySelector("li")).toBeNull();
    await act(async () => toggle.click());
    const row = container.querySelector("li");
    expect(row?.textContent).toContain(
      "DashboardPayments.counterparty.providerAccountFundingWallet USD"
    );
    expect(row?.textContent).toContain(text);
    const copyButton = row?.querySelector(
      'button[aria-label="DashboardCustody.copy dashboardpayments.counterparty.walletidlabel"]'
    );
    expect(Boolean(copyButton)).toBe(copy);
    expect(container.textContent?.split("Test Wallet Agreement")).toHaveLength(2);
    expect(toggle.textContent).not.toContain("Test Wallet Agreement");
    await act(async () => toggle.click());
    expect(container.textContent).not.toContain("Test Wallet Agreement");
    expect(container.querySelector("li")).toBeNull();
  });
});
