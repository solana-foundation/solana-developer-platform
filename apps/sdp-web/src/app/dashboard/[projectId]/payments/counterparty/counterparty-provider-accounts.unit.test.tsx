import type { CounterpartyProviderAccount } from "@sdp/types";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/environments";
import { CounterpartyDetailWorkspace } from "./counterparty-detail-workspace";
import { groupProviderAccounts } from "./counterparty-provider-accounts.utils";

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

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function providerAccount(
  overrides: Partial<CounterpartyProviderAccount>
): CounterpartyProviderAccount {
  return {
    id: "cpa_1",
    provider: "lightspark",
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
        providerAccountReference: "a:10000000000002:TESTWLT:1",
        balance: { state: "available", amount: "9.90", currency: "USD" },
        customerLink: {
          provider: "lightspark",
          id: "cpa_link",
          providerCustomerReference: "cust-1",
          status: "active",
          providerStatus: "VERIFIED",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
      providerAccount({
        id: "cpa_payout",
        provider: "coinbase",
        providerStatus: "VERIFIED",
      }),
    ]);

    expect(groups).toHaveLength(2);
    const lightspark = groups.find((group) => group.provider === "lightspark");
    expect(lightspark?.fundingWallets.map((account) => account.id)).toEqual(["cpa_funding"]);
    expect(lightspark?.payoutAccounts).toEqual([]);
    expect(lightspark?.customerLink?.provider).toBe("lightspark");
    const coinbase = groups.find((group) => group.provider === "coinbase");
    expect(coinbase?.payoutAccounts.map((account) => account.id)).toEqual(["cpa_payout"]);
    expect(coinbase?.fundingWallets).toEqual([]);
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
  async function renderWorkspace(account: CounterpartyProviderAccount, rampsEnabled: boolean) {
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
          rampsEnabled={rampsEnabled}
        />
      )
    );
  }
  async function renderWallet(account: CounterpartyProviderAccount) {
    await renderWorkspace(account, true);
    const toggle = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')
    ).find((button) => button.textContent?.includes("Lightspark"));
    if (toggle === undefined) throw new Error("Expected collapsed Lightspark provider accordion");
    return toggle;
  }
  function walletAccount(overrides: Partial<CounterpartyProviderAccount>) {
    return providerAccount({
      kind: "funding_wallet",
      destinationCountry: null,
      paymentRail: null,
      providerStatus: "provisioned_funding_wallet",
      providerAccountReference: "a:10000000000002:TESTWLT:1",
      customerLink: {
        provider: "lightspark",
        id: "cpa_link",
        providerCustomerReference: "00000000-0000-4000-8000-00000000c058",
        status: "active",
        providerStatus: "VERIFIED",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      ...overrides,
    });
  }

  it("leaves provider accounts out when ramps are off", async () => {
    await renderWorkspace(walletAccount({}), false);

    expect(container.textContent).not.toContain("DashboardPayments.counterparty.providerAccounts");
  });
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
        providerStatus: "provisioning_funding_wallet",
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
    await act(async () => toggle.click());
    expect(container.querySelector("li")).toBeNull();
  });
});
