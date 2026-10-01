// @vitest-environment jsdom

import type { CustodyWalletTokenBalance, PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { HomeActivityRow } from "./home-page.data";
import type { PaymentsIssuedTokenSymbol } from "./payments/payments-page.data";

const ISSUED_MINT = "Iss1edMintAddress1111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const mocks = vi.hoisted(() => ({
  workspace: {
    sdpEnvironment: "sandbox",
    flags: { custody: true, issuance: true, payments: true, policies: false },
    dashboardAccess: {
      capabilities: {
        canManageCustody: true,
        canManageTokenWrite: true,
        canManageApiKeys: true,
        canReadApprovals: true,
      },
    },
  },
  swr: {} as Record<string, { data?: unknown; error?: unknown }>,
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));
vi.mock("@/lib/dashboard-swr", () => ({
  usePersistedDashboardSWR: (key: string) => mocks.swr[key] ?? {},
}));
// The guide has its own tests; here it only has to keep its place at the top.
vi.mock("@/components/dashboard-quick-start.redesign", () => ({
  DashboardQuickStart: () => <div data-quick-start-stub />,
}));

const { HomeWorkspace } = await import("./home-workspace.redesign");

function row(id: string, overrides: Partial<HomeActivityRow> = {}): HomeActivityRow {
  return {
    id,
    createdAt: "2026-09-25T11:30:00.000Z",
    type: "Transfer",
    token: "USDC",
    tokenMint: USDC_MINT,
    amount: "12.5",
    status: "completed",
    address: ADDRESS,
    explorer: { kind: "tx", value: `sig_${id}` },
    sourceKind: "payments",
    ...overrides,
  };
}

const BALANCES: CustodyWalletTokenBalance[] = [
  {
    token: "USDC",
    mint: USDC_MINT,
    amount: "250000000",
    uiAmount: "250",
    decimals: 6,
    usdValue: 250,
  },
  {
    token: "ACME",
    mint: ISSUED_MINT,
    amount: "1000",
    uiAmount: "1000",
    decimals: 0,
    usdValue: 0,
  },
];
const ISSUED: PaymentsIssuedTokenSymbol[] = [
  { id: "tok_acme", mintAddress: ISSUED_MINT, symbol: "ACME", imageUrl: null },
];
const WALLET = { id: "w_1" } as unknown as PaymentsDashboardWallet;

function renderOverview(
  props: Partial<{
    totalBalance: number | null;
    totalBalanceError: string | null;
    wallets: PaymentsDashboardWallet[];
    balances: CustodyWalletTokenBalance[];
    walletCount: number;
  }> = {}
) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <HomeWorkspace
        totalBalance={props.totalBalance === undefined ? 250 : props.totalBalance}
        totalBalanceError={props.totalBalanceError ?? null}
        wallets={props.wallets ?? [WALLET]}
        balances={props.balances ?? BALANCES}
        walletCount={props.walletCount ?? 2}
        issuedTokens={ISSUED}
      />
    </I18nProvider>
  );
}

const section = (name: string) =>
  document.querySelector<HTMLElement>(`[data-overview-section="${name}"]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  mocks.workspace.flags = { custody: true, issuance: true, payments: true, policies: false };
  mocks.workspace.dashboardAccess.capabilities = {
    canManageCustody: true,
    canManageTokenWrite: true,
    canManageApiKeys: true,
    canReadApprovals: true,
  };
  mocks.swr = {
    "dashboard-home-activity": { data: { activityRows: [] } },
    "dashboard-home-volume": { data: { todaysVolume: 1234.5, todaysVolumeError: null } },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Overview (HomeWorkspace redesign)", () => {
  it("leads a populated organization with its balance, holdings, census and every action", () => {
    renderOverview();

    const balance = section("balance");
    expect(balance).toBeTruthy();
    const scoped = within(balance as HTMLElement);
    expect(scoped.getByText("Total balance")).toBeTruthy();
    // The total and the USDC row it is made of.
    expect(scoped.getAllByText("$250.00")).toHaveLength(2);
    expect(scoped.getByText("SDP-Minted")).toBeTruthy();
    expect(scoped.getByRole("link", { name: "2 wallets" }).getAttribute("href")).toBe(
      "/dashboard/wallets"
    );
    expect(scoped.getByRole("link", { name: "2 tokens held" })).toBeTruthy();
    expect(scoped.getByRole("link", { name: "$1,234.50 today’s volume" })).toBeTruthy();

    const actions = within(section("actions") as HTMLElement);
    expect(actions.getByText("Create a wallet")).toBeTruthy();
    expect(actions.getByText("Create a draft token")).toBeTruthy();
    expect(actions.getByText("Send a payment")).toBeTruthy();
    expect(actions.getByText("Issue an API key")).toBeTruthy();

    expect(document.querySelector("[data-quick-start-stub]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all payments" })).toBeTruthy();
    expect(screen.getByText("No recent activity found yet.")).toBeTruthy();
  });

  it("reads one wallet and one token in the singular and a dash while volume is unknown", () => {
    mocks.swr["dashboard-home-volume"] = { error: new Error("volume down") };
    renderOverview({ walletCount: 1, balances: [BALANCES[0] as CustodyWalletTokenBalance] });
    const balance = within(section("balance") as HTMLElement);
    expect(balance.getByText("wallet")).toBeTruthy();
    expect(balance.getByText("token held")).toBeTruthy();
    expect(balance.getByText("—")).toBeTruthy();
  });

  it("reports an unavailable balance instead of a false zero", () => {
    renderOverview({ totalBalance: null, totalBalanceError: "Balances are down." });
    const balance = within(section("balance") as HTMLElement);
    expect(balance.getByText("Unavailable")).toBeTruthy();
    expect(balance.getByText("Balances are down.")).toBeTruthy();
  });

  it("names holdings with no price feed rather than totalling them", () => {
    renderOverview({ totalBalance: null });
    expect(screen.getByText("Holdings with no price feed")).toBeTruthy();
  });

  it("turns the first run into the wallet prompt with no activity list", () => {
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(screen.getByRole("heading", { name: "Start with a wallet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a wallet" }).getAttribute("href")).toBe(
      "/dashboard/wallets/setup"
    );
    expect(section("activity")).toBeNull();
    const actions = within(section("actions") as HTMLElement);
    expect(actions.queryByText("Create a wallet")).toBeNull();
    expect(actions.queryByText("Send a payment")).toBeNull();
  });

  it("offers nothing a viewer cannot do", () => {
    mocks.workspace.flags = { custody: false, issuance: false, payments: false, policies: false };
    mocks.workspace.dashboardAccess.capabilities = {
      canManageCustody: false,
      canManageTokenWrite: false,
      canManageApiKeys: false,
      canReadApprovals: false,
    };
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(screen.queryByRole("link", { name: "Create a wallet" })).toBeNull();
    expect(section("actions")).toBeNull();
  });

  it("lists recent activity with its status, amount, token and explorer link", () => {
    mocks.workspace.flags.policies = true;
    mocks.swr["dashboard-home-activity"] = {
      data: {
        activityRows: [
          row("pay_1"),
          row("pay_2", {
            amount: "—",
            status: "failed",
            address: "—",
            explorer: null,
            createdAt: "not-a-date",
          }),
          row("mint_1", {
            sourceKind: "issuance",
            type: "Deploy",
            status: "failed",
            token: "ACME",
            tokenMint: ISSUED_MINT,
            amount: "—",
            explorer: { kind: "address", value: ADDRESS },
          }),
          row("pay_3", { tokenMint: null, explorer: null, token: "SOL" }),
        ],
        activityNotice: "Showing the latest 4.",
      },
    };
    renderOverview();

    const activity = within(section("activity") as HTMLElement);
    expect(activity.getByText("Showing the latest 4.")).toBeTruthy();
    const rows = activity.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("Completed");
    expect(rows[0]?.textContent).toContain("12.50 USDC");
    expect(
      within(rows[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toContain("sig_pay_1");
    expect(rows[1]?.textContent).toContain("Not sent");
    expect(rows[1]?.textContent).toContain("None");
    expect(rows[2]?.textContent).toContain("Deploy failed");
    expect(rows[2]?.textContent).toContain("Not minted");
    expect(
      within(rows[2] as HTMLElement)
        .getByRole("link")
        .getAttribute("href")
    ).toContain(ADDRESS);
    expect(within(rows[3] as HTMLElement).queryByRole("link")).toBeNull();
    expect(rows[3]?.textContent).toContain("9xQeWv");
  });

  it("drops issuance rows when Issuance is off", () => {
    mocks.workspace.flags.issuance = false;
    mocks.swr["dashboard-home-activity"] = {
      data: { activityRows: [row("pay_1"), row("mint_1", { sourceKind: "issuance" })] },
    };
    renderOverview();
    expect(within(section("activity") as HTMLElement).getAllByRole("row")).toHaveLength(2);
  });

  it("shows the activity error over its notice, and a loading line before the first read", () => {
    mocks.swr["dashboard-home-activity"] = { error: { error: "Ledger is down." } };
    const { unmount } = renderOverview();
    expect(screen.getByText("Ledger is down.")).toBeTruthy();
    unmount();

    mocks.swr["dashboard-home-activity"] = { error: "fetch failed" };
    const second = renderOverview();
    expect(screen.getByText("Activity is unavailable right now.")).toBeTruthy();
    second.unmount();

    mocks.swr["dashboard-home-activity"] = {
      data: { activityRows: [], activityError: "Partial outage.", activityNotice: "Hidden." },
    };
    const third = renderOverview();
    expect(screen.getByText("Partial outage.")).toBeTruthy();
    expect(screen.queryByText("Hidden.")).toBeNull();
    third.unmount();

    mocks.swr["dashboard-home-activity"] = {};
    renderOverview();
    expect(screen.getByText("Loading recent activity...")).toBeTruthy();
  });

  it("asks for a first wallet in the activity list while the wallet read is empty", () => {
    mocks.workspace.flags.payments = false;
    renderOverview({ wallets: [] });
    expect(
      screen.getByText("Create your first wallet to start tracking balances and activity.")
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "See all payments" })).toBeNull();
  });
});
