// @vitest-environment jsdom

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DashboardReadError } from "@/lib/dashboard-swr";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import type { HomeActivityRow } from "./home-page.data";
import type { PaymentsIssuedTokenSymbol } from "./payments/payments-page.data";

const ISSUED_MINT = "Iss1edMintAddress1111111111111111111111111";
const USDC_MINT = wellKnownMint("USDC", "mainnet-beta") ?? "";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const mocks = vi.hoisted(() => {
  const read: { activity: { data?: unknown; error?: unknown } } = { activity: {} };
  return {
    workspace: {
      sdpEnvironment: "sandbox",
      dashboardCacheScope: { userId: "user_h", orgId: "org_h" },
      selectedProjectId: "prj_test_sandbox",
      initialQuickStartStatus: { hasWallet: false, apiKeyCount: 0, lastCallAt: null },
      flags: { custody: true, issuance: true, payments: true },
      dashboardAccess: {
        capabilities: {
          canWrite: true,
          canManageCustody: true,
          canManageTokenWrite: true,
          canManageApiKeys: true,
        },
      },
    },
    read,
    useHomeActivitySnapshot: vi.fn((enabled: boolean) => (enabled ? read.activity : {})),
  };
});

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
  useCanWrite: () => mocks.workspace.dashboardAccess.capabilities.canWrite,
}));
vi.mock("./home-workspace.data", () => ({
  useHomeActivitySnapshot: mocks.useHomeActivitySnapshot,
}));
vi.mock("./overview-network.data", () => ({
  useOverviewNetwork: () => ({ status: "loading" }),
}));

const { HomeWorkspace } = await import("./home-workspace");

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

beforeEach(() => {
  resetDashboardNavigation();
  mocks.useHomeActivitySnapshot.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  mocks.workspace.flags = { custody: true, issuance: true, payments: true };
  mocks.workspace.dashboardAccess.capabilities = {
    canWrite: true,
    canManageCustody: true,
    canManageTokenWrite: true,
    canManageApiKeys: true,
  };
  mocks.read.activity = {
    data: {
      activityRows: [],
      todaysVolume: {
        transferCount: 3,
        amountByMint: { [USDC_MINT]: "1234.5" },
        complete: true,
        coversDay: true,
      },
      todaysVolumeError: null,
    },
  };
});

/** One SOL held where nothing prices it, as on devnet, where the API prices no mint. */
const UNPRICED_SOL: CustodyWalletTokenBalance = {
  token: "SOL",
  mint: SOL_MINT,
  amount: "1000000000",
  uiAmount: "1",
  decimals: 9,
};

/** Whether Home's activity read was enabled, across every render. */
function activityReadsEnabled(): Set<boolean> {
  return new Set(mocks.useHomeActivitySnapshot.mock.calls.map(([enabled]) => enabled));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Overview (HomeWorkspace)", () => {
  it("leads a populated organization with its balance, holdings, census and every action", () => {
    renderOverview();

    const scoped = within(requireSection("balance"));
    expect(scoped.getByText("Total balance")).toBeTruthy();
    // The total and the USDC row it is made of.
    expect(scoped.getAllByText("$250.00")).toHaveLength(2);
    expect(scoped.getByText("SDP-Minted")).toBeTruthy();
    const wallets = scoped.getByRole("link", { name: "2 wallets" });
    expect(wallets.getAttribute("href")).toBe("/dashboard/prj_test_sandbox/wallets");
    const tokens = scoped.getByRole("link", { name: "2 tokens held" });
    const volume = scoped.getByRole("link", { name: "$1,234.50 today’s volume" });
    // Wallets and tokens share a line and today's volume holds its own, so the volume figure
    // landing after the counts never rewraps them.
    expect(tokens.parentElement).toBe(wallets.parentElement);
    expect(wallets.parentElement?.contains(volume)).toBe(false);

    const actions = within(requireSection("actions"));
    expect(actions.getByText("Create a wallet")).toBeTruthy();
    expect(actions.getByText("Create a draft token")).toBeTruthy();
    expect(actions.getByText("Send a payment")).toBeTruthy();
    expect(actions.getByText("Issue an API key")).toBeTruthy();

    expect(section("quick-start")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all payments" })).toBeTruthy();
    expect(screen.getByText("No recent activity found yet.")).toBeTruthy();
    expect(activityReadsEnabled()).toEqual(new Set([true]));
  });

  it("reads one wallet and one token in the singular and a dash while volume is unknown", () => {
    // A wallet missed its read: the list can say so, but a total over the rest would understate.
    mocks.read.activity = {
      data: {
        activityRows: [],
        todaysVolume: null,
        todaysVolumeError: "Payments activity is unavailable right now.",
      },
    };
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

  it("lists a holding with no price beside the count, and says the total leaves it out", () => {
    renderOverview({ balances: [at(BALANCES, 0), UNPRICED_SOL] });
    const balance = within(requireSection("balance"));
    expect(balance.getByRole("link", { name: "2 tokens held" })).toBeTruthy();
    expect(balance.getByText("SOL")).toBeTruthy();
    expect(
      balance.getByRole("button", { name: "Excludes 1 token with no price feed." })
    ).toBeTruthy();
  });

  it("counts today's payments when one moved a token with no price, never adding SOL to dollars", () => {
    mocks.read.activity = {
      data: {
        activityRows: [],
        todaysVolume: {
          transferCount: 2,
          amountByMint: { [SOL_MINT]: "0.5", [USDC_MINT]: "10" },
          complete: true,
          coversDay: true,
        },
        todaysVolumeError: null,
      },
    };
    renderOverview({ balances: [at(BALANCES, 0), UNPRICED_SOL] });
    const balance = within(requireSection("balance"));
    expect(balance.getByRole("link", { name: "2 payments today" })).toBeTruthy();
  });

  it("marks today's volume as a floor when the read stopped short of midnight", () => {
    mocks.read.activity = {
      data: {
        activityRows: [],
        todaysVolume: {
          transferCount: 20,
          amountByMint: { [USDC_MINT]: "20" },
          complete: true,
          coversDay: false,
        },
        todaysVolumeError: null,
      },
    };
    renderOverview();
    const balance = within(requireSection("balance"));
    expect(balance.getByRole("link", { name: "$20.00+ today’s volume" })).toBeTruthy();
  });

  it("turns the first run into the wallet prompt with no activity list", () => {
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(screen.getByRole("heading", { name: "Start with a wallet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a wallet" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets/setup"
    );
    expect(section("activity")).toBeNull();
    // Neither the list nor the volume is on screen, so their read is never made.
    expect(activityReadsEnabled()).toEqual(new Set([false]));
    const actions = within(requireSection("actions"));
    expect(actions.queryByText("Create a wallet")).toBeNull();
    expect(actions.queryByText("Send a payment")).toBeNull();
  });

  // Stable runs no Issuance, and its first run told a new organization about tokens it issues.
  it("names the token in the first-run prompt only where Issuance runs", () => {
    mocks.workspace.flags.issuance = false;
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(
      screen.getByText("Everything else here needs one: a payment has to leave from somewhere.")
    ).toBeTruthy();
    expect(screen.queryByText(/token you issue/)).toBeNull();
  });

  it("offers nothing a viewer cannot do", () => {
    mocks.workspace.flags = { custody: false, issuance: false, payments: false };
    mocks.workspace.dashboardAccess.capabilities = {
      canWrite: false,
      canManageCustody: false,
      canManageTokenWrite: false,
      canManageApiKeys: false,
    };
    renderOverview({ wallets: [], balances: [], walletCount: 0, totalBalance: null });
    expect(screen.queryByRole("link", { name: "Create a wallet" })).toBeNull();
    expect(
      screen.getByText(
        "You have read-only access. Ask a teammate who can make changes to add the first one."
      )
    ).toBeTruthy();
    expect(section("actions")).toBeNull();
  });

  it("offers a read-only member no payment to send, with payments on", () => {
    // A viewer's capabilities: every module flag on, but nothing beyond reads.
    mocks.workspace.dashboardAccess.capabilities = {
      canWrite: false,
      canManageCustody: false,
      canManageTokenWrite: false,
      canManageApiKeys: false,
    };
    renderOverview();
    expect(screen.queryByText("Send a payment")).toBeNull();
    expect(section("actions")).toBeNull();
    expect(screen.getByRole("link", { name: "See all payments" })).toBeTruthy();
  });

  it("lists recent activity with its status, amount, token and explorer link", () => {
    mocks.read.activity = {
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
    mocks.read.activity = {
      data: { activityRows: [row("pay_1"), row("mint_1", { sourceKind: "issuance" })] },
    };
    renderOverview();
    expect(within(requireSection("activity")).getAllByRole("row")).toHaveLength(2);
  });

  it("shows the activity error over its notice, and a loading line before the first read", () => {
    mocks.read.activity = { error: new DashboardReadError(503, null, null) };
    const failed = renderOverview();
    expect(screen.getByText("Activity is unavailable right now.")).toBeTruthy();
    failed.unmount();

    mocks.read.activity = {
      data: { activityRows: [], activityError: "Partial outage.", activityNotice: "Hidden." },
    };
    const { unmount } = renderOverview();
    expect(screen.getByText("Partial outage.")).toBeTruthy();
    expect(screen.queryByText("Hidden.")).toBeNull();
    unmount();

    mocks.read.activity = {};
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
