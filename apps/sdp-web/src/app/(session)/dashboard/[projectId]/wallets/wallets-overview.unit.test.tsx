// @vitest-environment jsdom

import type { CustodyWalletOwner, CustodyWalletSummary } from "@sdp/types/custody";
import type { OrganizationRole } from "@sdp/types/roles";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHeaderTabsTrailingContext } from "@/components/dashboard-header-tabs-trailing-context";
import { readWalletFavorites, walletFavoritesKey } from "@/lib/wallet-favorites";
import { stubClerkSession } from "@/test/clerk";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import {
  dashboardRouter,
  resetDashboardNavigation,
  setDashboardUrl,
} from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";
import { required } from "@/test/required";
import { syntheticWalletAddress, walletsWorkspace } from "@/test/wallets";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { WalletsOverview } = await import("./wallets-overview");

const WALLETS_PATH = `/dashboard/${SANDBOX_PROJECT.id}/wallets`;
const BALANCES_PATH = "/api/dashboard/wallets?includeBalances=true&view=summary";

function favoritesKey(): string {
  const key = walletFavoritesKey({ userId: "user_test", orgId: "org_test" }, SANDBOX_PROJECT.id);
  if (key === null) throw new Error("The Sandbox Project has no favorites key");
  return key;
}

function makeWallet(
  overrides: Partial<Omit<CustodyWalletSummary, keyof CustodyWalletOwner>>
): CustodyWalletSummary {
  return {
    id: "row",
    custodyConfigId: "config",
    provider: "fireblocks",
    isRuntimeExecutionAllowed: true,
    walletId: "fb_wallet",
    publicKey: syntheticWalletAddress(1),
    label: "Settlement Fireblocks",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const SETTLEMENT = makeWallet({});
const OFF_RAMP = makeWallet({
  id: "row-2",
  provider: "dfns",
  walletId: "wa-offramp",
  publicKey: syntheticWalletAddress(2),
  label: "Off ramp demo wallet",
  purpose: "root",
});

let slot: HTMLDivElement;
let fetchMock: ReturnType<typeof stubDashboardFetch>;

function openOverview(search = "") {
  setDashboardUrl(`${WALLETS_PATH}${search}`, {});
  window.history.replaceState(null, "", `${WALLETS_PATH}${search}`);
}

function renderOverview(
  overrides: Partial<ComponentProps<typeof WalletsOverview>> = {},
  role: OrganizationRole = "admin"
) {
  const Workspace = walletsWorkspace(role);
  return render(
    <WalletsOverview
      canManageCustody={role === "admin"}
      configsError={null}
      wallets={[SETTLEMENT, OFF_RAMP]}
      walletsError={null}
      {...overrides}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Workspace>
          <DashboardHeaderTabsTrailingContext.Provider value={slot}>
            {children}
          </DashboardHeaderTabsTrailingContext.Provider>
          <Toaster />
        </Workspace>
      ),
    }
  );
}

/** Presses Undo on the toast titled `title`. */
async function undoFrom(title: string): Promise<void> {
  const toast = required(
    (await screen.findByText(title)).closest<HTMLElement>("[data-sonner-toast]")
  );
  fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
}

function walletLinks(): HTMLElement[] {
  return screen.queryAllByRole("link", { name: /^Open / });
}

beforeEach(() => {
  stubClerkSession();
  resetDashboardNavigation();
  openOverview();
  window.localStorage.clear();
  slot = document.createElement("div");
  document.body.append(slot);
  fetchMock = stubDashboardFetch(async () =>
    dashboardDataResponse(200, {
      wallets: [
        { walletId: SETTLEMENT.walletId, balances: [] },
        { walletId: OFF_RAMP.walletId, balances: [] },
      ],
    })
  );
});
afterEach(() => {
  cleanup();
  slot.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("wallet cards", () => {
  it("names each wallet with its purpose and provider, root wallets included", () => {
    renderOverview();
    const settlement = screen.getByRole("link", { name: "Open Settlement Fireblocks" });
    const offRamp = screen.getByRole("link", { name: "Open Off ramp demo wallet" });
    expect(screen.getByText("Transfers · Fireblocks")).not.toBeNull();
    expect(screen.getByText("Root wallet · DFNS")).not.toBeNull();
    expect(settlement.getAttribute("href")).toBe(`${WALLETS_PATH}/fb_wallet`);
    expect(offRamp.getAttribute("href")).toBe(`${WALLETS_PATH}/wa-offramp`);
  });

  it("marks only a wallet whose signing is restricted", () => {
    renderOverview({
      wallets: [{ ...SETTLEMENT, isRuntimeExecutionAllowed: false }, OFF_RAMP],
    });
    expect(screen.getAllByText(/Restricted/)).toHaveLength(1);
  });

  it("re-reads the wallets and their balances from the tab row, and switches to the list", async () => {
    renderOverview();
    await waitFor(() => expect(sentDashboardRequests(fetchMock)).toHaveLength(1));

    fireEvent.click(within(slot).getByRole("button", { name: "Refresh wallets and balances" }));
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(sentDashboardRequests(fetchMock).map((request) => request.path)).toEqual([
        BALANCES_PATH,
        BALANCES_PATH,
      ])
    );

    act(() => {
      fireEvent.click(within(slot).getByRole("radio", { name: "List" }));
    });
    expect(window.location.search).toBe("?view=list");
  });

  it("says when the balances arrived, and nothing before they have", async () => {
    renderOverview();
    expect(slot.querySelector("time")).toBeNull();

    const time = await waitFor(() => {
      const element = slot.querySelector("time");
      if (element === null) throw new Error("No refresh time yet");
      return element;
    });
    expect(time.getAttribute("dateTime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves the tab row alone on the API Playground tab", () => {
    openOverview("?tab=playground");
    renderOverview();
    expect(slot.childElementCount).toBe(0);
  });

  it("lists the wallets as rows when the list view is chosen", () => {
    openOverview("?view=list");
    renderOverview();
    const [, settlementRow, offRampRow] = screen.getAllByRole("row");
    expect(within(settlementRow).getByText("Transfers · Fireblocks")).not.toBeNull();
    expect(within(offRampRow).getByText("Root wallet · DFNS")).not.toBeNull();
  });
});

describe("search", () => {
  it("shows no field for a handful of wallets, and ignores a search left in the URL", () => {
    openOverview("?query=offramp");
    renderOverview();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(walletLinks()).toHaveLength(2);
  });

  it("filters a long list by the search in the URL", () => {
    openOverview("?query=vault-7");
    const many = Array.from({ length: 8 }, (_, index) =>
      makeWallet({
        id: `row-${index}`,
        walletId: `vault-${index}`,
        publicKey: syntheticWalletAddress(10 + index),
        label: `Vault ${index}`,
      })
    );
    renderOverview({ wallets: many });
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "vault-7");
    expect(walletLinks().map((link) => link.getAttribute("href"))).toEqual([
      `${WALLETS_PATH}/vault-7`,
    ]);
  });
});

describe("empty and failed lists", () => {
  it("sends an admin with no wallets to the setup flow", () => {
    renderOverview({ wallets: [] });
    expect(screen.getByRole("link", { name: "Create wallet" }).getAttribute("href")).toBe(
      `${WALLETS_PATH}/setup`
    );
  });

  it("offers a member with no wallets nothing to create", () => {
    renderOverview({ wallets: [] }, "member");
    expect(screen.getByText("No wallets available")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Create wallet" })).toBeNull();
  });

  it("reports a failed read instead of an empty project", () => {
    renderOverview({ walletsError: "Upstream timed out" });
    expect(screen.getByRole("alert").textContent).toContain("Upstream timed out");
    expect(screen.queryByRole("link", { name: "Create wallet" })).toBeNull();
    expect(walletLinks()).toHaveLength(0);
  });

  // The loading view holds the tab row; a row that came and went would move the page.
  it.each<[string, Partial<ComponentProps<typeof WalletsOverview>>]>([
    ["no wallets", { wallets: [] }],
    ["a failed read", { walletsError: "Upstream timed out" }],
  ])("keeps the tab row's place with %s, where there is no toolbar", (_state, overrides) => {
    renderOverview(overrides);
    expect(slot.childElementCount).toBe(1);
    expect(within(slot).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("favorites", () => {
  it("pins a wallet to the sidebar and undoes it from the toast", async () => {
    renderOverview();
    fireEvent.click(screen.getByRole("button", { name: "Add Off ramp demo wallet to favorites" }));

    expect(readWalletFavorites(favoritesKey())).toEqual([
      { walletId: "wa-offramp", name: "Off ramp demo wallet", provider: "dfns" },
    ]);
    expect(
      screen
        .getByRole("button", { name: "Remove Off ramp demo wallet from favorites" })
        .getAttribute("aria-pressed")
    ).toBe("true");

    await undoFrom("Added to favorites");
    expect(readWalletFavorites(favoritesKey())).toEqual([]);
  });

  it("unpins a wallet, and Undo puts it back in its place", async () => {
    renderOverview();
    fireEvent.click(screen.getByRole("button", { name: "Add Settlement Fireblocks to favorites" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Off ramp demo wallet to favorites" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Settlement Fireblocks from favorites" })
    );

    expect(readWalletFavorites(favoritesKey()).map((favorite) => favorite.walletId)).toEqual([
      "wa-offramp",
    ]);
    await undoFrom("Removed from favorites");
    expect(readWalletFavorites(favoritesKey()).map((favorite) => favorite.walletId)).toEqual([
      "fb_wallet",
      "wa-offramp",
    ]);
  });

  it("renames pins and drops wallets that are gone when the list loads", () => {
    window.localStorage.setItem(
      favoritesKey(),
      JSON.stringify([
        { walletId: "wa-offramp", name: "Old name", provider: "dfns" },
        { walletId: "deleted", name: "Gone", provider: "para" },
      ])
    );
    renderOverview();
    expect(readWalletFavorites(favoritesKey())).toEqual([
      { walletId: "wa-offramp", name: "Off ramp demo wallet", provider: "dfns" },
    ]);
  });

  it("keeps the pins when the list failed to load", () => {
    const stored = [{ walletId: "deleted", name: "Gone", provider: "para" }];
    window.localStorage.setItem(favoritesKey(), JSON.stringify(stored));
    renderOverview({ walletsError: "Upstream timed out" });
    expect(readWalletFavorites(favoritesKey())).toEqual(stored);
  });
});
