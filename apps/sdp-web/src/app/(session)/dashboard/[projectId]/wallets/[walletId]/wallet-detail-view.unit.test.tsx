// @vitest-environment jsdom

import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type State, SWRConfig, unstable_serialize } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { custodyQueryKeys } from "@/app/(session)/dashboard/[projectId]/wallets/custody-query-key";
import type {
  WalletActivityPayload,
  WalletActivityRow,
} from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.data";
import { stubClerkSession } from "@/test/clerk";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  type SentDashboardRequest,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { stubMatchMedia } from "@/test/media-queries";
import { SANDBOX_PROJECT } from "@/test/projects";
import { required } from "@/test/required";
import {
  syntheticWalletAddress,
  syntheticWalletSignature,
  WalletsTestWorkspace,
} from "@/test/wallets";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import type { WalletPageView, WalletTab } from "./wallet-detail.shared";
import { WalletDetailView } from "./wallet-detail-view";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const USDC = WELL_KNOWN_TOKENS.USDC;
// A Sandbox Project runs on devnet, where the API prices nothing: USDC is valued by its mint.
const USDC_MINT = requiredWellKnownMint("USDC", "devnet");
const WALLET_PATH = `/dashboard/${SANDBOX_PROJECT.id}/wallets/wallet_one`;
const ACTIVITY_PATH = "/api/dashboard/wallets/wallet_one/activity";

const OUTGOING_ROW = {
  id: "payment-xfr_7c1c0000c1c7",
  sourceKind: "payments",
  operationLabel: "Outgoing",
  status: "finalized",
  signature: null,
  token: USDC_MINT,
  amount: "500.00",
  address: syntheticWalletAddress(2),
  createdAt: "2026-09-11T00:00:00.000Z",
} satisfies WalletActivityRow;

const INCOMING_ROW = {
  id: "payment-xfr_a0460000a2a63",
  sourceKind: "payments",
  operationLabel: "Incoming",
  status: "pending",
  signature: null,
  token: USDC_MINT,
  amount: "1250.00",
  address: syntheticWalletAddress(3),
  createdAt: "2026-09-10T00:00:00.000Z",
} satisfies WalletActivityRow;

const wallet: WalletPageView = {
  walletId: "wallet_one",
  custodyWalletId: "cwlt_one",
  name: "Settlement Fireblocks",
  label: "Settlement Fireblocks",
  publicKey: syntheticWalletAddress(1),
  provider: "fireblocks",
  providerName: "Fireblocks",
  purposeLabel: "Transfers",
  createdAt: "2026-06-30T00:00:00.000Z",
  isRuntimeExecutionAllowed: true,
  supportsSignerCheck: true,
  connection: null,
  canManageCustody: true,
};

/** The feed's answer; its rows stay plain JSON so the stub can serve them. */
function feed<Row extends WalletActivityRow>(activityRows: Row[], hasMore: boolean) {
  return { activityRows, activityError: null, activityNotice: null, hasMore };
}

function rowsOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...OUTGOING_ROW,
    id: `payment-xfr_row_${index}`,
  }));
}

/** The window an activity read asked for; the route reads 20 rows when the page names none. */
function windowOf(request: SentDashboardRequest): number {
  const url = new URL(request.path, "https://dashboard.test");
  expect(url.pathname).toBe(ACTIVITY_PATH);
  const limit = url.searchParams.get("limit");
  return limit === null ? 20 : Number(limit);
}

/** Serves the wallet's activity feed: `answer` decides each window's read. */
function stubActivity(answer: (window: number) => Response) {
  return stubDashboardFetch((request) => answer(windowOf(request)));
}

/** Serves `payload` for every window. */
function serveActivity(payload: Parameters<typeof dashboardDataResponse>[1]) {
  return stubActivity(() => dashboardDataResponse(200, payload));
}

/**
 * Renders the wallet's page on `tab` over an SWR cache the test may seed, as a later visit
 * finds what an earlier one read.
 */
async function renderView(
  view: WalletPageView,
  tab: WalletTab,
  cachedActivity: WalletActivityPayload | null
) {
  const url = tab === "overview" ? WALLET_PATH : `${WALLET_PATH}?tab=${tab}`;
  setDashboardUrl(url, { walletId: "wallet_one" });
  setWindowPathname(url);
  const cache = new Map<string, State>();
  if (cachedActivity !== null) {
    cache.set(unstable_serialize(custodyQueryKeys.walletActivity({ walletId: "wallet_one" })), {
      data: cachedActivity,
    });
  }
  await act(async () => {
    render(
      <WalletsTestWorkspace organizationRole="admin" releaseChannel="stable">
        <SWRConfig
          value={{ provider: () => cache, shouldRetryOnError: false, dedupingInterval: 0 }}
        >
          <WalletDetailView
            wallet={view}
            balancesPromise={Promise.resolve({
              balances: [
                {
                  token: USDC.symbol,
                  mint: USDC_MINT,
                  amount: "4000000000",
                  uiAmount: "4000",
                  decimals: USDC.mints.devnet.decimals,
                },
              ],
              error: null,
            })}
            issuedTokensPromise={Promise.resolve({})}
            issuanceEnabled
          />
        </SWRConfig>
      </WalletsTestWorkspace>
    );
  });
}

/** The activity table, once the feed has rendered it. */
async function activityTable(): Promise<HTMLElement> {
  await screen.findAllByText(/xfr_/);
  const table = document.querySelector<HTMLElement>("[data-wallet-activity-table]");
  if (table === null) throw new Error("Expected the activity table on the page");
  return table;
}

/** The wallet's total balance, once its balances have resolved. */
async function walletBalance(): Promise<HTMLElement> {
  await screen.findAllByText("$4,000.00");
  return required(document.querySelector<HTMLElement>("[data-wallet-balance]"));
}

/** The details under the one open activity row. */
function openRowDetails(): HTMLElement {
  const details = document.querySelector<HTMLElement>("[data-wallet-activity-details]");
  if (details === null) throw new Error("Expected an open row's details on the page");
  return details;
}

beforeEach(() => {
  resetDashboardNavigation();
  stubClerkSession();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Overview", () => {
  it("shows the balance and the recent activity, and opens the Activity tab from it", async () => {
    serveActivity(feed([OUTGOING_ROW, INCOMING_ROW], false));
    await renderView(wallet, "overview", null);

    expect((await walletBalance()).textContent).toBe("$4,000.00");
    expect(screen.getByText("Active")).toBeTruthy();
    const activity = await activityTable();
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View all activity" }));

    expect(window.location.search).toBe("?tab=activity");
    expect(await screen.findByPlaceholderText("Search this wallet's activity")).toBeTruthy();
  });

  it("shows the provider and purpose, and lists the held token with its mint", async () => {
    serveActivity(feed([], false));
    await renderView(wallet, "overview", null);

    const mint = await screen.findByText("4zMM...ncDU");
    const tokens = mint.closest<HTMLElement>("[data-wallet-tokens]");
    if (tokens === null) throw new Error("Expected the mint inside the tokens table");
    const row = mint.closest<HTMLElement>("tr");
    if (row === null) throw new Error("Expected the mint inside a token row");
    expect(within(row).getByText("USDC")).toBeTruthy();
    expect(within(row).getByText("$4,000.00")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Copy usdc mint" })).toBeTruthy();
    expect(within(tokens).getAllByRole("row")).toHaveLength(2);

    const facts = [...document.querySelectorAll("[data-record-fact]")].map((fact) => {
      const label = fact.querySelector("dt");
      const value = fact.querySelector("dd");
      if (label === null || value === null) throw new Error("Expected a label and a value");
      return [label.textContent, value.textContent];
    });
    expect(facts).toEqual(
      expect.arrayContaining([
        ["Provider", "Fireblocks"],
        ["Purpose", "Transfers"],
      ])
    );
  });

  // Stable runs neither Ramps nor Issuance, so the band names Payments alone.
  it("names the connection the wallet signs through and links it", async () => {
    serveActivity(feed([], false));
    await renderView(
      {
        ...wallet,
        provider: "privy",
        providerName: "Privy",
        connection: { label: "Treasury app", href: "/dashboard/prj/integrations/privy/c" },
      },
      "overview",
      null
    );

    expect(
      await screen.findByText("Payments can sign with this wallet. It signs through Treasury app.")
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Treasury app" }).getAttribute("href")).toBe(
      "/dashboard/prj/integrations/privy/c"
    );
  });

  it("opens one row at a time, with the explorer only for a signed row", async () => {
    const signature = syntheticWalletSignature(1);
    serveActivity(feed([{ ...OUTGOING_ROW, signature }, INCOMING_ROW], false));
    await renderView(wallet, "overview", null);

    const [openFirst, openSecond] = within(await activityTable()).getAllByRole("button", {
      name: "Details",
    });
    if (openFirst === undefined || openSecond === undefined) {
      throw new Error("Expected a Details toggle on each row");
    }

    fireEvent.click(openFirst);
    expect(openFirst.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(openRowDetails()).getByRole("link", { name: "View on explorer" }).getAttribute("href")
    ).toContain(signature);

    fireEvent.click(openSecond);
    expect(openFirst.getAttribute("aria-expanded")).toBe("false");
    const pending = openRowDetails();
    expect(within(pending).getByText("None yet")).toBeTruthy();
    expect(within(pending).queryByRole("link", { name: "View on explorer" })).toBeNull();
  });

  it("keeps the recent rows when a refresh fails, and says the activity is unavailable", async () => {
    stubActivity(() => dashboardErrorResponse(503, "upstream unavailable"));
    await renderView(wallet, "overview", feed([OUTGOING_ROW, INCOMING_ROW], false));

    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    const activity = await activityTable();
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();
  });

  it("says a restricted wallet cannot sign, and offers no faucet", async () => {
    serveActivity(feed([], false));
    await renderView({ ...wallet, isRuntimeExecutionAllowed: false }, "overview", null);

    expect(await screen.findByText("Restricted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request devnet SOL" })).toBeNull();
  });
});

describe("Activity", () => {
  it("searches the wallet's activity and points the full history at this wallet's ledger", async () => {
    serveActivity(feed([OUTGOING_ROW, INCOMING_ROW], false));
    await renderView(wallet, "activity", null);

    expect(await screen.findAllByText(/xfr_/)).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("Search this wallet's activity"), {
      target: { value: "a046" },
    });

    expect(screen.getAllByText(/xfr_/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
    const ledgerLinks = screen.getAllByRole("link", { name: "Open in Transactions" });
    expect(ledgerLinks.map((link) => link.getAttribute("href"))).toEqual(
      ledgerLinks.map(
        () => `/dashboard/${SANDBOX_PROJECT.id}/payments/transactions?custodyWalletId=cwlt_one`
      )
    );
  });

  it("keeps the loaded rows when a refresh fails, and says the activity is unavailable", async () => {
    stubActivity(() => dashboardErrorResponse(503, "upstream unavailable"));
    await renderView(wallet, "activity", feed([OUTGOING_ROW, INCOMING_ROW], false));

    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    expect(screen.getAllByText(/xfr_/)).toHaveLength(2);
  });

  it("asks the feed for 100 more rows when the user loads older activity", async () => {
    const fetchMock = serveActivity(feed(rowsOf(20), true));
    await renderView(wallet, "activity", null);

    expect(await screen.findByText(/latest 20 transactions loaded here/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    });

    expect(sentDashboardRequests(fetchMock).map(windowOf)).toContain(120);
  });

  it("keeps the loaded rows when older activity fails, and tries the same window again", async () => {
    const fetchMock = stubActivity((window) =>
      window === 20
        ? dashboardDataResponse(200, feed(rowsOf(20), true))
        : dashboardErrorResponse(503, "upstream unavailable")
    );
    await renderView(wallet, "activity", null);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Load older activity" }));
    });

    expect(
      await screen.findByText(
        "Older activity didn't load. The latest 20 transactions are still shown."
      )
    ).toBeTruthy();
    expect(screen.getAllByText(/xfr_row_/)).toHaveLength(20);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try loading older activity again" }));
    });

    await waitFor(() =>
      expect(
        sentDashboardRequests(fetchMock)
          .map(windowOf)
          .filter((window) => window !== 20)
      ).toEqual([120, 120])
    );
    expect(
      await screen.findByRole("button", { name: "Try loading older activity again" })
    ).toBeTruthy();
  });

  it("offers older activity only from the last page of what is loaded", async () => {
    serveActivity(feed(rowsOf(30), true));
    await renderView(wallet, "activity", null);

    expect(await screen.findByText("Page 1 of 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getByRole("button", { name: "Load older activity" })).toBeTruthy();
  });
});

describe("Settings", () => {
  it("lets a signing wallet prove ownership", async () => {
    serveActivity(feed([], false));
    await renderView(wallet, "settings", null);

    expect(await screen.findByRole("button", { name: "Prove ownership" })).toHaveProperty(
      "disabled",
      false
    );
  });

  it("explains why a restricted wallet cannot prove ownership", async () => {
    serveActivity(feed([], false));
    await renderView({ ...wallet, isRuntimeExecutionAllowed: false }, "settings", null);

    expect(await screen.findByRole("button", { name: "Prove ownership" })).toHaveProperty(
      "disabled",
      true
    );
    expect(
      screen.getByText("This wallet cannot sign right now, so the check cannot run.")
    ).toBeTruthy();
  });
});
