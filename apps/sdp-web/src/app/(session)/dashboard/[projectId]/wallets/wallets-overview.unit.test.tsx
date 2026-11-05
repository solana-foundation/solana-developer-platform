// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { readWalletFavorites, walletFavoritesKey } from "@/lib/wallet-favorites";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { useCustodyWallets } from "./custody-reads";

const mocks = vi.hoisted(() => ({
  query: "",
  toast: vi.fn(),
  replaceSearchParams: vi.fn(),
}));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({
    searchParams: new URLSearchParams(mocks.query),
    replaceSearchParams: mocks.replaceSearchParams,
  }),
  useDashboardTab: () => new URLSearchParams(mocks.query).get("tab"),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user", orgId: "org" },
    selectedProjectId: "project",
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "project" },
  }),
}));
vi.mock("@/app/(session)/dashboard/[projectId]/wallets/wallet-card-balance-value", () => ({
  WalletCardBalanceValue: () => <span>Balance</span>,
}));
vi.mock("@/components/dashboard-header-tabs", () => ({
  DashboardHeaderTabsTrailing: ({ children }: { children: ReactNode }) => (
    <div data-testid="tab-row">{children}</div>
  ),
}));
vi.mock("./wallet-provider-mark", () => ({
  WalletProviderMark: () => <span data-testid="mark" />,
}));

const { WalletsOverview } = await import("./wallets-overview");

const KEY = walletFavoritesKey({ userId: "user", orgId: "org" }, "project") as string;

function makeWallet(overrides: Partial<CustodyWalletSummary>): CustodyWalletSummary {
  return {
    id: "row",
    custodyConfigId: "config",
    provider: "fireblocks",
    isRuntimeExecutionAllowed: true,
    walletId: "fb_wallet",
    publicKey: "gZeTc7Hq9mXw2JDUBSD",
    label: "Settlement Fireblocks",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as CustodyWalletSummary;
}

const wallets = [
  makeWallet({}),
  makeWallet({
    id: "row-2",
    provider: "dfns",
    walletId: "wa-offramp",
    publicKey: "EGyaAv4Lr8nTqfQ723i",
    label: "Off ramp demo wallet",
    purpose: "root",
  }),
];

const WALLETS_URL = "/api/dashboard/wallets";
const SUMMARIES_URL = "/api/dashboard/wallets?includeBalances=true&view=summary";

function Overview({ canManageCustody }: { canManageCustody: boolean }) {
  const walletsRead = useCustodyWallets();
  return (
    <WalletsOverview
      canManageCustody={canManageCustody}
      configsError={null}
      walletsRead={walletsRead}
    />
  );
}

function answerWallets(listed: CustodyWalletSummary[]) {
  return stubDashboardFetch(() => Response.json({ data: { wallets: listed } }));
}

function failWalletsRead() {
  return stubDashboardFetch(({ path }) =>
    path === WALLETS_URL
      ? dashboardErrorResponse(503, "Upstream timed out")
      : Response.json({ data: { wallets: [] } })
  );
}

function renderView(canManageCustody: boolean) {
  return render(
    <DashboardReadsProvider>
      <EnglishI18n>
        <Overview canManageCustody={canManageCustody} />
      </EnglishI18n>
    </DashboardReadsProvider>
  );
}

async function listSettled() {
  await waitFor(() => expect(document.querySelector("[data-wallet-grid-skeleton]")).toBeNull());
}

async function renderOverview(listed: CustodyWalletSummary[]): Promise<Mock<typeof fetch>> {
  const fetchMock = answerWallets(listed);
  renderView(true);
  await listSettled();
  return fetchMock;
}

beforeEach(() => {
  resetDashboardNavigation();
  mocks.query = "";
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet cards", () => {
  it("names each wallet with its purpose and provider, root wallets included", async () => {
    await renderOverview(wallets);
    const settlement = screen.getByText("Settlement Fireblocks").closest("article");
    const offRamp = screen.getByText("Off ramp demo wallet").closest("article");
    expect(within(settlement as HTMLElement).getByText("Transfers · Fireblocks")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Root wallet · DFNS")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Address")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Wallet ID")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Off ramp demo wallet" }).getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox/wallets/wa-offramp");
  });

  it("marks only a wallet whose signing is restricted", async () => {
    await renderOverview([{ ...wallets[0], isRuntimeExecutionAllowed: false }, wallets[1]]);
    expect(screen.getAllByText(/Restricted/)).toHaveLength(1);
  });

  it("puts the refresh and the view toggle in the tab row, and refreshes both reads", async () => {
    const fetchMock = await renderOverview(wallets);
    await waitFor(() => expect(sentDashboardReads(fetchMock)).toHaveLength(2));
    fetchMock.mockClear();
    const tabRow = screen.getByTestId("tab-row");
    fireEvent.click(within(tabRow).getByRole("button", { name: "Refresh wallets and balances" }));
    await waitFor(() =>
      expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
        WALLETS_URL,
        SUMMARIES_URL,
      ])
    );
    fireEvent.click(within(tabRow).getByRole("radio", { name: "List" }));
    expect(mocks.replaceSearchParams).toHaveBeenCalledWith({ view: "list" });
  });

  it("says when the balances arrived, and nothing before they have", async () => {
    const { promise: summaries, resolve: answerSummaries } = Promise.withResolvers<Response>();
    stubDashboardFetch(({ path }) =>
      path === SUMMARIES_URL ? summaries : Response.json({ data: { wallets } })
    );
    renderView(true);
    expect(await screen.findByText("Settlement Fireblocks")).toBeTruthy();
    expect(document.querySelector("[data-wallets-refreshed-at]")).toBeNull();

    answerSummaries(Response.json({ data: { wallets } }));

    await waitFor(() =>
      expect(
        document.querySelector("[data-wallets-refreshed-at]")?.getAttribute("dateTime")
      ).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    );
  });

  it("leaves the tab row alone on the API Playground tab", async () => {
    mocks.query = "tab=playground";
    await renderOverview(wallets);
    expect(screen.queryByTestId("tab-row")).toBeNull();
  });

  it("lists the wallets as rows when the list view is chosen", async () => {
    mocks.query = "view=list";
    await renderOverview(wallets);
    const rows = document.querySelectorAll("[data-wallet-list] [data-wallet-row]");
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText("Root wallet · DFNS")).toBeTruthy();
  });
});

describe("search", () => {
  it("shows no field for a handful of wallets, and ignores a search left in the URL", async () => {
    mocks.query = "query=offramp";
    await renderOverview(wallets);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(document.querySelectorAll("[data-wallet-card]")).toHaveLength(2);
  });

  it("filters a long list by the search in the URL", async () => {
    mocks.query = "query=vault-7";
    const many = Array.from({ length: 8 }, (_, index) =>
      makeWallet({
        id: `row-${index}`,
        walletId: `vault-${index}`,
        label: `Vault ${index}`,
      })
    );
    await renderOverview(many);
    expect(document.querySelector("[data-wallet-search-toolbar]")).toBeTruthy();
    expect(document.querySelectorAll("[data-wallet-card]")).toHaveLength(1);
    expect(screen.getByText("Showing 1 of 8 wallets")).toBeTruthy();
  });
});

describe("loading, empty and failed lists", () => {
  it("holds the cards' skeleton until the list arrives", async () => {
    const { promise: list, resolve: answerList } = Promise.withResolvers<Response>();
    stubDashboardFetch(({ path }) =>
      path === WALLETS_URL ? list : Response.json({ data: { wallets } })
    );
    renderView(true);
    expect(document.querySelector("[data-wallet-grid-skeleton]")).not.toBeNull();

    answerList(Response.json({ data: { wallets } }));

    expect(await screen.findByText("Settlement Fireblocks")).toBeTruthy();
    expect(document.querySelector("[data-wallet-grid-skeleton]")).toBeNull();
  });

  it("invites an admin to create the first wallet", async () => {
    await renderOverview([]);
    expect(screen.getByText("Create your first wallet")).toBeTruthy();
  });

  it.each([
    ["no wallets", () => answerWallets([])],
    ["a failed read", failWalletsRead],
  ])("keeps the toolbar's row, with no toolbar, for %s", async (_label, answer) => {
    answer();
    renderView(true);
    await listSettled();
    const tabRow = screen.getByTestId("tab-row");
    expect(tabRow.querySelector("span.h-7")).not.toBeNull();
    expect(within(tabRow).queryByRole("button")).toBeNull();
  });

  it("tells a member who cannot create wallets why the list is empty", async () => {
    answerWallets([]);
    renderView(false);
    expect(await screen.findByText("No wallets available")).toBeTruthy();
  });

  it("reports a failed read instead of an empty project, and reads again on retry", async () => {
    const fetchMock = failWalletsRead();
    renderView(true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unable to load wallets");

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        sentDashboardReads(fetchMock).filter((read) => read.path === WALLETS_URL)
      ).toHaveLength(2)
    );
  });
});

describe("favorites", () => {
  it("pins a wallet to the sidebar and undoes it from the toast", async () => {
    await renderOverview(wallets);
    const star = screen.getByRole("button", { name: "Add Off ramp demo wallet to favorites" });
    fireEvent.click(star);

    expect(readWalletFavorites(KEY)).toEqual([
      { walletId: "wa-offramp", name: "Off ramp demo wallet", provider: "dfns" },
    ]);
    expect(
      screen
        .getByRole("button", { name: "Remove Off ramp demo wallet from favorites" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    const [title, options] = mocks.toast.mock.calls[0] as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Added to favorites");
    expect(options.description).toBe("Off ramp demo wallet is in the sidebar under Wallets.");

    options.action.onClick();
    expect(readWalletFavorites(KEY)).toEqual([]);
  });

  it("unpins a wallet, and Undo puts it back in its place", async () => {
    await renderOverview(wallets);
    fireEvent.click(screen.getByRole("button", { name: "Add Settlement Fireblocks to favorites" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Off ramp demo wallet to favorites" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Settlement Fireblocks from favorites" })
    );

    expect(readWalletFavorites(KEY).map((favorite) => favorite.walletId)).toEqual(["wa-offramp"]);
    const [title, options] = mocks.toast.mock.calls[2] as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(title).toBe("Removed from favorites");
    options.action.onClick();
    expect(readWalletFavorites(KEY).map((favorite) => favorite.walletId)).toEqual([
      "fb_wallet",
      "wa-offramp",
    ]);
  });

  it("renames pins and drops wallets that are gone when the list loads", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { walletId: "wa-offramp", name: "Old name", provider: "dfns" },
        { walletId: "deleted", name: "Gone", provider: "para" },
      ])
    );
    await renderOverview(wallets);
    expect(readWalletFavorites(KEY)).toEqual([
      { walletId: "wa-offramp", name: "Off ramp demo wallet", provider: "dfns" },
    ]);
  });

  it("keeps the pins when the list failed to load", async () => {
    const stored = [{ walletId: "deleted", name: "Gone", provider: "para" }];
    window.localStorage.setItem(KEY, JSON.stringify(stored));
    failWalletsRead();
    renderView(true);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(readWalletFavorites(KEY)).toEqual(stored);
  });
});
