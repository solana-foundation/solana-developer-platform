import {
  BVNK_FUNDING_WALLET_STATUS,
  type CounterpartyAccount,
  type CounterpartyProviderAccount,
  type PaymentTransferSummary,
} from "@sdp/types";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinEnvironments, type EnvironmentReturn } from "vitest/environments";
import { CounterpartyDetailWorkspace } from "./counterparty-detail-workspace.redesign";
import { groupProviderAccounts } from "./counterparty-provider-accounts.utils";

vi.mock("@/i18n/provider", () => ({
  useTranslations:
    () =>
    (
      key: string,
      values?: {
        label?: string;
        currency?: string;
        amounts?: string;
        count?: number;
      }
    ) =>
      values?.label
        ? `${key} ${values.label}`
        : values?.currency
          ? `${key} ${values.currency}`
          : values?.amounts
            ? `${key} ${values.amounts}`
            : values?.count !== undefined
              ? `${key} ${values.count}`
              : key,
  useLocale: () => "en",
}));

vi.mock("next/image", () => ({ default: () => null }));

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
  usePathname: () => "/dashboard/payments/counterparty/cpty_test",
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
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

const accountState = vi.hoisted(() => ({
  accounts: [] as CounterpartyProviderAccount[],
  error: undefined as Error | undefined,
}));
vi.mock("./use-counterparty-provider-accounts", () => ({
  useCounterpartyProviderAccounts: () => ({
    data: accountState.accounts,
    error: accountState.error,
  }),
}));
describe("counterparty provider accounts table", () => {
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
    accountState.error = undefined;
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await environment.teardown(globalThis);
  });
  interface History {
    transfers?: PaymentTransferSummary[];
    transfersFailed?: boolean;
    payouts?: PaymentTransferSummary[];
    payoutsTotal?: number;
    payoutsFailed?: boolean;
    addresses?: CounterpartyAccount[];
    addressesTotal?: number;
    addressesFailed?: boolean;
  }
  function workspace(history: History) {
    return (
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
        initialAccounts={history.addresses ?? []}
        accountsTotal={history.addressesTotal}
        accountsFailed={history.addressesFailed}
        initialTransfers={history.transfers ?? []}
        transfersFailed={history.transfersFailed}
        payouts={history.payouts ?? []}
        payoutsTotal={history.payoutsTotal}
        payoutsFailed={history.payoutsFailed}
        rampsEnabled={true}
      />
    );
  }
  async function renderAccounts(accounts: CounterpartyProviderAccount[], history: History = {}) {
    accountState.accounts = accounts;
    container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container);
    await act(async () => root.render(workspace(history)));
  }
  async function renderWallet(account: CounterpartyProviderAccount) {
    await renderAccounts([account]);
    const row = container.querySelector<HTMLTableRowElement>(
      'tr[data-provider-account-kind="funding_wallet"]'
    );
    if (row === null) throw new Error("Expected a funding wallet row");
    return row;
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
  }>)("renders $name in the wallet row", async ({ overrides, text, copy }) => {
    const row = await renderWallet(walletAccount(overrides));
    expect(row.textContent).toContain("BVNK");
    expect(row.textContent).toContain(
      "DashboardPayments.counterparty.providerAccountFundingWallet USD"
    );
    expect(row.textContent).toContain(text);
    const copyButton = row.querySelector(
      'button[aria-label="DashboardCustody.copy dashboardpayments.counterparty.walletidlabel"]'
    );
    expect(Boolean(copyButton)).toBe(copy);
    // The agreement the provider wants accepted is listed once, under the table.
    expect(row.textContent).not.toContain("Test Wallet Agreement");
    expect(container.textContent?.split("Test Wallet Agreement")).toHaveLength(2);
  });

  it("gives a customer link carried on the provider's accounts its own row, once", async () => {
    // With accounts present the API sends no separate customer-link row; each account carries it.
    const link = walletAccount({}).customerLink;
    await renderAccounts([
      walletAccount({ id: "cpa_wallet" }),
      providerAccount({ id: "cpa_payout", customerLink: link }),
    ]);

    const customerRows = container.querySelectorAll(
      'tr[data-provider-account-kind="customer_link"]'
    );
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0]?.textContent).toContain("US");
    expect(
      customerRows[0]?.querySelector(
        'button[aria-label="DashboardCustody.copy dashboardpayments.counterparty.customeridlabel"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelectorAll('tr[data-provider-account-kind="funding_wallet"]')
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('tr[data-provider-account-kind="payout_account"]')
    ).toHaveLength(1);
  });

  it("keeps the loaded customer details when a later refresh fails, and says so", async () => {
    // SWR keeps the last good read in `data` and sets `error` when a revalidation fails.
    accountState.error = new Error("Provider read timed out");
    await renderAccounts([walletAccount({ id: "cpa_wallet" })]);

    const customerRow = container.querySelector('tr[data-provider-account-kind="customer_link"]');
    expect(customerRow?.textContent).toContain("US");
    expect(
      customerRow?.querySelector(
        'button[aria-label="DashboardCustody.copy dashboardpayments.counterparty.customeridlabel"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelectorAll('tr[data-provider-account-kind="funding_wallet"]')
    ).toHaveLength(1);
    expect(container.textContent).toContain("Test Wallet Agreement");
    expect(container.textContent).toContain(
      "DashboardPayments.counterparty.detail.providerAccountsRefreshFailed"
    );
    expect(container.textContent).not.toContain(
      "DashboardPayments.counterparty.detail.providerAccountsFailed"
    );
  });

  it("reports a failed first read rather than an empty list", async () => {
    accountState.error = new Error("Provider read timed out");
    await renderAccounts([]);
    const text = container.textContent ?? "";
    expect(text).toContain("DashboardPayments.counterparty.detail.providerAccountsFailed");
    expect(text).not.toContain("DashboardPayments.counterparty.detail.noProviderAccounts");
  });

  it("keeps the customer details when a funding wallet has no currency yet", async () => {
    // The wallet row renders a dash for the missing currency; the customer row must survive it.
    await renderAccounts([walletAccount({ id: "cpa_wallet", fiatCurrency: null })]);
    const customerRow = container.querySelector('tr[data-provider-account-kind="customer_link"]');
    expect(customerRow?.textContent).toContain("US");
    expect(container.textContent).toContain("Test Wallet Agreement");
  });

  function payout(id: string, amount: string): PaymentTransferSummary {
    return {
      id,
      custodyWalletId: null,
      providerWalletId: "pw_1",
      status: "completed",
      signature: null,
      direction: "outbound",
      token: "USDC",
      amount,
      rampsMemo: {},
      createdAt: "2026-01-02T00:00:00.000Z",
    };
  }

  it("adds payouts as decimals, so the total does not pick up float rounding", async () => {
    await renderAccounts([], {
      payouts: [payout("tx_1", "0.1"), payout("tx_2", "0.2"), payout("tx_3", "9007199254740993")],
    });
    expect(container.textContent).toContain("9,007,199,254,740,993.30 USDC");
  });

  it("totals payouts older than the latest transfers", async () => {
    // The latest transfers hold no settled payout; the payout read still has an older one.
    await renderAccounts([], {
      transfers: [{ ...payout("tx_new", "5"), status: "failed" }],
      payouts: [{ ...payout("tx_old", "12"), createdAt: "2025-06-01T00:00:00.000Z" }],
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("DashboardPayments.counterparty.detail.notPaidYet");
    expect(text).toContain("DashboardPayments.counterparty.detail.paidSummary 12.00 USDC");
  });

  it("qualifies the total when the payout read stopped at its cap", async () => {
    await renderAccounts([], {
      payouts: [payout("tx_1", "5"), payout("tx_2", "6")],
      payoutsTotal: 900,
    });
    expect(container.textContent).toContain(
      "DashboardPayments.counterparty.detail.paidSummaryPartial 11.00 USDC"
    );
  });

  it("says the payment history was not loaded when the transfers read failed", async () => {
    await renderAccounts([], { transfersFailed: true, payoutsFailed: true });
    const text = container.textContent ?? "";
    expect(text).not.toContain("DashboardPayments.counterparty.detail.notPaidYet");
    expect(text).not.toContain("DashboardPayments.counterparty.detail.noPayments");
    expect(text.split("DashboardPayments.counterparty.detail.paymentsNotLoaded")).toHaveLength(3);
    expect(text).toContain("DashboardPayments.counterparty.detail.paymentsLoadFailed");
    expect(text).toContain("Shared.SharedComponents.retry");
  });

  function savedAddress(id: string): CounterpartyAccount {
    return {
      id,
      organizationId: "org_test",
      projectId: "prj_test",
      counterpartyId: "cpty_test",
      accountKind: "crypto_wallet",
      label: null,
      details: { address: "So11111111111111111111111111111111111111112" },
      providerAccountData: {},
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("does not say no addresses are saved when the address read failed", async () => {
    await renderAccounts([], { addressesFailed: true });
    const text = container.textContent ?? "";
    expect(text).not.toContain("DashboardPayments.counterparty.detail.noAddresses");
    expect(text).toContain("DashboardPayments.counterparty.detail.addressesLoadFailed");
  });

  it("shows the addresses a successful Retry loads after a failed read", async () => {
    await renderAccounts([], { addressesFailed: true });
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Shared.SharedComponents.retry"
    );
    if (retry === undefined) throw new Error("Expected a retry button");
    await act(async () => retry.click());
    expect(routerRefresh).toHaveBeenCalled();
    // The refresh hands the page the read it retried.
    await act(async () => root.render(workspace({ addresses: [savedAddress("cpa_1")] })));
    const text = container.textContent ?? "";
    expect(text).not.toContain("DashboardPayments.counterparty.detail.addressesLoadFailed");
    expect(text).not.toContain("DashboardPayments.counterparty.detail.noAddresses");
    expect(text).toContain("DashboardPayments.counterparty.detail.unnamedAddress");
  });

  it("says how many saved addresses it left out when the read was capped", async () => {
    await renderAccounts([], { addresses: [savedAddress("cpa_1")], addressesTotal: 140 });
    expect(container.textContent).toContain(
      "DashboardPayments.counterparty.detail.addressesCapped 1"
    );
  });
});
