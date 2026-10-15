// @vitest-environment jsdom

import type { CustodyWalletTokenBalance, PaymentsDashboardWallet } from "@sdp/types";
import { wellKnownMint } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SWRResponse } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as dashboardSwr from "@/lib/dashboard-swr";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import type { HomeActivityRow } from "./home-page.data";
import type { PaymentsIssuedTokenSymbol } from "./payments/payments-page.data";

const ISSUED_MINT = "Iss1edMintAddress1111111111111111111111111";
const USDC_MINT = wellKnownMint("USDC", "mainnet-beta") ?? "";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const mocks = vi.hoisted(() => {
  const swr: Record<string, { data?: unknown; error?: unknown }> = {};
  return {
    workspace: {
      sdpEnvironment: "sandbox",
      dashboardCacheScope: { userId: "user_h", orgId: "org_h" },
      selectedProjectId: "prj_test_sandbox",
      initialQuickStartStatus: { custodyProvider: null, apiKeyCount: 0, lastCallAt: null },
      flags: { newDesign: true, custody: true, issuance: true, payments: true },
      dashboardAccess: {
        capabilities: {
          canManageCustody: true,
          canManageTokenWrite: true,
          canManageApiKeys: true,
        },
      },
    },
    swr,
  };
});

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
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
// SAFETY: the Overview reads a wallet only to count it, so a bare id stands in for the summary.
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

/** A section the test expects on the page. */
function requireSection(name: string): HTMLElement {
  const found = section(name);
  if (!found) throw new Error(`No ${name} section`);
  return found;
}

/** The element at an index of a list the test has already counted. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at ${index}`);
  return item;
}

/** What the persisted SWR hook returns for the data a test seeded under a key. */
function seededSwr(key: unknown): SWRResponse<unknown, unknown> {
  const seeded = typeof key === "string" ? mocks.swr[key] : undefined;
  return {
    data: seeded?.data,
    error: seeded?.error,
    isLoading: false,
    isValidating: false,
    mutate: async () => undefined,
  };
}

beforeEach(() => {
  resetDashboardNavigation();
  // SAFETY: the stand-in serves whatever the test seeded under the key; each caller reads it as
  // the data type it asked for.
  vi.spyOn(dashboardSwr, "usePersistedDashboardSWR").mockImplementation(
    seededSwr as typeof dashboardSwr.usePersistedDashboardSWR
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  mocks.workspace.flags = { newDesign: true, custody: true, issuance: true, payments: true };
  mocks.workspace.dashboardAccess.capabilities = {
    canManageCustody: true,
    canManageTokenWrite: true,
    canManageApiKeys: true,
  };
  mocks.swr = {
    "dashboard-home-activity": { data: { activityRows: [] } },
    "dashboard-home-volume": { data: { todaysVolume: 1234.5, todaysVolumeError: null } },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Overview (HomeWorkspace redesign)", () => {
  it("leads a populated organization with its balance, holdings, census and every action", () => {
    renderOverview();

    const scoped = within(requireSection("balance"));
    expect(scoped.getByText("Total balance")).toBeTruthy();
    // The total and the USDC row it is made of.
    expect(scoped.getAllByText("$250.00")).toHaveLength(2);
    expect(scoped.getByText("SDP-Minted")).toBeTruthy();
    expect(scoped.getByRole("link", { name: "2 wallets" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets"
    );
    expect(scoped.getByRole("link", { name: "2 tokens held" })).toBeTruthy();
    expect(scoped.getByRole("link", { name: "$1,234.50 today’s volume" })).toBeTruthy();

    const actions = within(requireSection("actions"));
    expect(actions.getByText("Create a wallet")).toBeTruthy();
    expect(actions.getByText("Create a draft token")).toBeTruthy();
    expect(actions.getByText("Send a payment")).toBeTruthy();
    expect(actions.getByText("Issue an API key")).toBeTruthy();

    expect(section("quick-start")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all payments" })).toBeTruthy();
    expect(screen.getByText("No recent activity found yet.")).toBeTruthy();
  });

  it("reads one wallet and one token in the singular and a dash while volume is unknown", () => {
    mocks.swr["dashboard-home-volume"] = { error: new Error("volume down") };
    renderOverview({ walletCount: 1, balances: [at(BALANCES, 0)] });
    const balance = within(requireSection("balance"));
    expect(balance.getByText("wallet")).toBeTruthy();
    expect(balance.getByText("token held")).toBeTruthy();
    expect(balance.getByText("—")).toBeTruthy();
  });

  it("reports an unavailable balance instead of a false zero", () => {
    renderOverview({ totalBalance: null, totalBalanceError: "Balances are down." });
    const balance = within(requireSection("balance"));
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
      "/dashboard/prj_test_sandbox/wallets/setup"
    );
    expect(section("activity")).toBeNull();
    const actions = within(requireSection("actions"));
    expect(actions.queryByText("Create a wallet")).toBeNull();
    expect(actions.queryByText("Send a payment")).toBeNull();
  });

  it("offers nothing a viewer cannot do", () => {
    mocks.workspace.flags = { newDesign: true, custody: false, issuance: false, payments: false };
    mocks.workspace.dashboardAccess.capabilities = {
      canManageCustody: false,
      canManageTokenWrite: false,
      canManageApiKeys: false,
    };
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(screen.queryByRole("link", { name: "Create a wallet" })).toBeNull();
    expect(section("actions")).toBeNull();
  });

  it("lists recent activity with its status, amount, token and explorer link", () => {
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

    const activity = within(requireSection("activity"));
    expect(activity.getByText("Showing the latest 4.")).toBeTruthy();
    const rows = activity.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("Transfer completed");
    expect(rows[0]?.textContent).toContain("12.50 USDC");
    expect(within(at(rows, 0)).getByRole("link").getAttribute("href")).toContain("sig_pay_1");
    expect(rows[1]?.textContent).toContain("Not sent");
    expect(rows[1]?.textContent).toContain("None");
    expect(rows[2]?.textContent).toContain("Deploy failed");
    expect(rows[2]?.textContent).toContain("Not minted");
    expect(within(at(rows, 2)).getByRole("link").getAttribute("href")).toContain(ADDRESS);
    expect(within(at(rows, 3)).queryByRole("link")).toBeNull();
    expect(rows[3]?.textContent).toContain("9xQeWv");
  });

  it("drops issuance rows when Issuance is off", () => {
    mocks.workspace.flags.issuance = false;
    mocks.swr["dashboard-home-activity"] = {
      data: { activityRows: [row("pay_1"), row("mint_1", { sourceKind: "issuance" })] },
    };
    renderOverview();
    expect(within(requireSection("activity")).getAllByRole("row")).toHaveLength(2);
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
