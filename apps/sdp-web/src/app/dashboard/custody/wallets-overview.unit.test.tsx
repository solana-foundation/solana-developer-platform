// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { readWalletFavorites, walletFavoritesKey } from "@/lib/wallet-favorites";

const mocks = vi.hoisted(() => ({
  query: "",
  toast: vi.fn(),
  refresh: vi.fn(),
  mutate: vi.fn(),
  replaceSearchParams: vi.fn(),
  balances: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({
    searchParams: new URLSearchParams(mocks.query),
    replaceSearchParams: mocks.replaceSearchParams,
  }),
  useDashboardTab: () => new URLSearchParams(mocks.query).get("tab"),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user", orgId: "org" },
    selectedProjectId: "project",
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "project" },
  }),
}));
vi.mock("@/app/dashboard/custody/wallet-card-balance-value", () => ({
  WalletCardBalanceValue: () => <span>Balance</span>,
  useWalletCardBalances: () => ({
    data: mocks.balances,
    error: undefined,
    isValidating: false,
    mutate: mocks.mutate,
  }),
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

function renderOverview(overrides: Partial<ComponentProps<typeof WalletsOverview>> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletsOverview
        canManageCustody
        configsError={null}
        wallets={wallets}
        walletsError={null}
        {...overrides}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.query = "";
  mocks.balances = undefined;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("wallet cards", () => {
  it("names each wallet with its purpose and provider, root wallets included", () => {
    renderOverview();
    const settlement = screen.getByText("Settlement Fireblocks").closest("article");
    const offRamp = screen.getByText("Off ramp demo wallet").closest("article");
    expect(within(settlement as HTMLElement).getByText("Transfers · Fireblocks")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Root wallet · DFNS")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Address")).toBeTruthy();
    expect(within(offRamp as HTMLElement).getByText("Wallet ID")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Off ramp demo wallet" }).getAttribute("href")
    ).toBe("/dashboard/wallets/wa-offramp");
  });

  it("marks only a wallet whose signing is restricted", () => {
    renderOverview({
      wallets: [{ ...wallets[0], isRuntimeExecutionAllowed: false }, wallets[1]],
    });
    expect(screen.getAllByText(/Restricted/)).toHaveLength(1);
  });

  it("puts the refresh and the view toggle in the tab row, and refreshes both reads", () => {
    renderOverview();
    const tabRow = screen.getByTestId("tab-row");
    fireEvent.click(within(tabRow).getByRole("button", { name: "Refresh wallets and balances" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    fireEvent.click(within(tabRow).getByRole("radio", { name: "List" }));
    expect(mocks.replaceSearchParams).toHaveBeenCalledWith({ view: "list" });
  });

  it("says when the balances arrived, and nothing before they have", () => {
    renderOverview();
    expect(document.querySelector("[data-wallets-refreshed-at]")).toBeNull();
    cleanup();
    mocks.balances = { fb_wallet: [] };
    renderOverview();
    const time = document.querySelector("[data-wallets-refreshed-at]");
    expect(time?.getAttribute("dateTime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves the tab row alone on the API Playground tab", () => {
    mocks.query = "tab=playground";
    renderOverview();
    expect(screen.queryByTestId("tab-row")).toBeNull();
  });

  it("lists the wallets as rows when the list view is chosen", () => {
    mocks.query = "view=list";
    renderOverview();
    const rows = document.querySelectorAll("[data-wallet-list] [data-wallet-row]");
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText("Root wallet · DFNS")).toBeTruthy();
  });
});

describe("search", () => {
  it("shows no field for a handful of wallets, and ignores a search left in the URL", () => {
    mocks.query = "query=offramp";
    renderOverview();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(document.querySelectorAll("[data-wallet-card]")).toHaveLength(2);
  });

  it("filters a long list by the search in the URL", () => {
    mocks.query = "query=vault-7";
    const many = Array.from({ length: 8 }, (_, index) =>
      makeWallet({
        id: `row-${index}`,
        walletId: `vault-${index}`,
        label: `Vault ${index}`,
      })
    );
    renderOverview({ wallets: many });
    expect(document.querySelector("[data-wallet-search-toolbar]")).toBeTruthy();
    expect(document.querySelectorAll("[data-wallet-card]")).toHaveLength(1);
    expect(screen.getByText("Showing 1 of 8 wallets")).toBeTruthy();
  });
});

describe("empty and failed lists", () => {
  it("invites an admin to create the first wallet", () => {
    renderOverview({ wallets: [] });
    expect(screen.getByText("Create your first wallet")).toBeTruthy();
    expect(screen.queryByTestId("tab-row")).toBeNull();
  });

  it("tells a member who cannot create wallets why the list is empty", () => {
    renderOverview({ wallets: [], canManageCustody: false });
    expect(screen.getByText("No wallets available")).toBeTruthy();
  });

  it("reports a failed read instead of an empty project", () => {
    renderOverview({ walletsError: "Upstream timed out" });
    expect(screen.getByRole("alert").textContent).toContain("Upstream timed out");
  });
});

describe("favorites", () => {
  it("pins a wallet to the sidebar and undoes it from the toast", () => {
    renderOverview();
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

  it("unpins a wallet, and Undo puts it back in its place", () => {
    renderOverview();
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

  it("renames pins and drops wallets that are gone when the list loads", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { walletId: "wa-offramp", name: "Old name", provider: "dfns" },
        { walletId: "deleted", name: "Gone", provider: "para" },
      ])
    );
    renderOverview();
    expect(readWalletFavorites(KEY)).toEqual([
      { walletId: "wa-offramp", name: "Off ramp demo wallet", provider: "dfns" },
    ]);
  });

  it("keeps the pins when the list failed to load", () => {
    const stored = [{ walletId: "deleted", name: "Gone", provider: "para" }];
    window.localStorage.setItem(KEY, JSON.stringify(stored));
    renderOverview({ walletsError: "Upstream timed out" });
    expect(readWalletFavorites(KEY)).toEqual(stored);
  });
});
