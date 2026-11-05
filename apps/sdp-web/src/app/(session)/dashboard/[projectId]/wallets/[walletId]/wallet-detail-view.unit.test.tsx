// @vitest-environment jsdom

import type { CustodyWalletMetadata, CustodyWalletTokenBalance } from "@sdp/types/custody";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletActivityRow } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.data";
import { DashboardPageTitleContext } from "@/components/dashboard-page-title-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardErrorResponse, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";

// jsdom implements no matchMedia, while the activity table's motion components read it.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const mocks = vi.hoisted(() => ({
  tab: null as string | null,
  replaceSearchParams: vi.fn(),
  refresh: vi.fn(),
  activity: {
    activityRows: [] as unknown[],
    activityError: null as string | null,
    activityNotice: null as string | null,
    hasMore: false as boolean,
  },
  activityLimits: [] as (number | undefined)[],
  widerActivityFails: false,
  /** The loaded window's latest refresh fails, so SWR holds its rows and an error. */
  activityRefreshFails: false,
  retryActivity: vi.fn(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { loading: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardTab: () => mocks.tab,
  useDashboardUrlState: () => ({
    searchParams: new URLSearchParams(),
    replaceSearchParams: mocks.replaceSearchParams,
  }),
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    sandboxProject: { id: "project" },
    selectedProjectId: "project",
    dashboardCacheScope: { userId: "user", orgId: "org" },
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true, canManageCustody: true } },
    flags: { dvp: false, issuance: false, markets: false, ramps: false },
  }),
}));
vi.mock("@/app/(session)/dashboard/[projectId]/wallets/actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: vi.fn(),
  updateWalletLabelAction: vi.fn(),
}));
vi.mock("@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span data-testid="mark" />,
}));
vi.mock("./use-wallet-activity", async () => {
  const { useEffect } = await import("react");
  return {
    useWalletActivity: (
      _walletId: string,
      limit?: number,
      callbacks: { onSuccess?: (data: unknown) => void; onError?: (error: Error) => void } = {}
    ) => {
      mocks.activityLimits.push(limit);
      const fails = mocks.widerActivityFails && limit !== 20;
      // Like SWR, report how the read this hook started settled.
      useEffect(() => {
        if (fails) callbacks.onError?.(new Error("unavailable"));
        else callbacks.onSuccess?.(mocks.activity);
      }, [limit]);
      if (fails) {
        return {
          data: undefined,
          error: new Error("unavailable"),
          isValidating: false,
          mutate: mocks.retryActivity,
        };
      }
      return {
        data: mocks.activity,
        error: mocks.activityRefreshFails ? new Error("Activity refresh failed") : undefined,
        isValidating: false,
        mutate: vi.fn(),
      };
    },
  };
});

const { WalletDetailView } = await import("./wallet-detail-view");

/** What a query found, or a failure naming what is missing, so a test needs no assertion. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} on the page`);
  }
  return value;
}

/** The activity table, once the streamed balances and the feed have rendered it. */
async function waitForActivityTable(): Promise<HTMLElement> {
  await screen.findAllByText(/xfr_/);
  return present(
    document.querySelector<HTMLElement>("[data-wallet-activity-table]"),
    "the activity table"
  );
}

/** The details under the one open activity row. */
function openRowDetails(): HTMLElement {
  return present(
    document.querySelector<HTMLElement>("[data-wallet-activity-details]"),
    "an open row's details"
  );
}

const OUTGOING_ROW: WalletActivityRow = {
  id: "payment-xfr_7c1c0000c1c7",
  sourceKind: "payments",
  operationLabel: "Outgoing",
  status: "finalized",
  signature: null,
  token: USDC,
  amount: "500.00",
  address: "Dq73aaaaaaaaaaaaaaaaaaaa2KCh",
  createdAt: "2026-09-11T00:00:00.000Z",
};

const INCOMING_ROW: WalletActivityRow = {
  id: "payment-xfr_a0460000a2a63",
  sourceKind: "payments",
  operationLabel: "Incoming",
  status: "pending",
  signature: null,
  token: USDC,
  amount: "1250.00",
  address: "FSegbbbbbbbbbbbbbbbbbb2WSY",
  createdAt: "2026-09-10T00:00:00.000Z",
};

const WALLET_FIELDS = {
  id: "cwlt_one",
  isRuntimeExecutionAllowed: true,
  walletId: "wallet_one",
  publicKey: "gZeTc7Hq9mXw2JDUBSDgZeTc7Hq9mXw2JDUBSD",
  label: "Settlement Fireblocks",
  purpose: "transfer",
  status: "active",
  createdAt: "2026-06-30T00:00:00.000Z",
} as const;

const wallet: CustodyWalletMetadata = {
  ...WALLET_FIELDS,
  provider: "fireblocks",
  custodyConfigId: "cfg_test_1",
};

const USDC_BALANCE: CustodyWalletTokenBalance = {
  token: "USDC",
  mint: USDC,
  amount: "4000000000",
  uiAmount: "4000",
  decimals: 6,
  usdValue: 4000,
};

interface WalletRecordBody {
  wallet: CustodyWalletMetadata;
  connection: { label: string; href: string | null } | null;
}

const BALANCES_PATH = "/api/dashboard/payments/wallets/wallet_one/balances";

function walletAnswer(record: WalletRecordBody | number, path: string): Response {
  if (path === "/api/dashboard/wallets/wallet_one") {
    return typeof record === "number"
      ? dashboardErrorResponse(record, "Wallet unavailable")
      : Response.json({ data: record });
  }
  if (path === BALANCES_PATH) {
    return Response.json({ data: { walletBalances: { balances: [USDC_BALANCE] } } });
  }
  return Response.json({ data: [], total: 0, hasMore: false });
}

function answerWallet(record: WalletRecordBody | number) {
  return stubDashboardFetch(({ path }) => walletAnswer(record, path));
}

function readsTree(children: ReactNode) {
  return (
    <DashboardReadsProvider>
      <I18nProvider locale="en" messages={getMessages("en")}>
        {children}
      </I18nProvider>
    </DashboardReadsProvider>
  );
}

function viewTree() {
  return readsTree(<WalletDetailView walletId="wallet_one" issuanceEnabled />);
}

function renderView(record: WalletRecordBody | number) {
  answerWallet(record);
  return render(viewTree());
}

beforeEach(() => {
  resetDashboardNavigation();
  mocks.tab = null;
  mocks.activity = {
    activityRows: [OUTGOING_ROW, INCOMING_ROW],
    activityError: null,
    activityNotice: null,
    hasMore: false,
  };
  mocks.activityLimits = [];
  mocks.widerActivityFails = false;
  mocks.activityRefreshFails = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("the wallet's record", () => {
  it("shows the Project's not-found view for a wallet the API cannot find", async () => {
    await act(async () => {
      renderView(404);
    });
    expect(
      (await screen.findByRole("link", { name: "Back to overview" })).getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox");
  });

  it("shows the not-found view when a revisit finds the cached wallet gone", async () => {
    const { rerender } = renderView({ wallet, connection: null });
    expect(await screen.findByText("Payments can sign with this wallet.")).toBeTruthy();
    rerender(readsTree(null));
    answerWallet(404);

    rerender(viewTree());

    expect(
      (await screen.findByRole("link", { name: "Back to overview" })).getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox");
  });

  it("mutes the balance and token figures, noted stale, when a balance refresh fails", async () => {
    const { rerender } = renderView({ wallet, connection: null });
    expect(
      await screen.findByText("$4,000.00", { selector: "[data-wallet-balance]" })
    ).toBeTruthy();
    rerender(readsTree(null));
    stubDashboardFetch(({ path }) =>
      path === BALANCES_PATH
        ? dashboardErrorResponse(503, "Balances unavailable")
        : walletAnswer({ wallet, connection: null }, path)
    );

    rerender(viewTree());

    const figure = await waitFor(() => {
      const shown = present(
        document.querySelector<HTMLElement>("[data-wallet-balance]"),
        "the balance figure"
      );
      expect(shown.textContent).toContain("$4,000.00 (stale)");
      return shown;
    });
    expect(figure.className).toContain("text-muted");
    const tokens = present(
      document.querySelector<HTMLElement>("[data-wallet-tokens]"),
      "the tokens table"
    );
    expect(
      within(tokens)
        .getAllByText("(stale)")
        .map((note) => present(note.closest("td"), "the note's cell").className)
    ).toEqual([expect.stringContaining("text-muted"), expect.stringContaining("text-muted")]);
  });

  it("says the wallet could not be loaded, and loads it on retry", async () => {
    renderView(503);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This wallet could not be loaded.");

    answerWallet({ wallet, connection: null });
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Payments can sign with this wallet.")).toBeTruthy();
  });

  it("calls an unlabelled wallet untitled rather than by its address", async () => {
    const setTitle = vi.fn();
    answerWallet({ wallet: { ...wallet, label: null }, connection: null });
    render(
      <DashboardPageTitleContext.Provider value={setTitle}>
        {viewTree()}
      </DashboardPageTitleContext.Provider>
    );

    expect(await screen.findByText("Payments can sign with this wallet.")).toBeTruthy();
    expect(setTitle).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Untitled wallet" })
    );
  });
});

describe("Overview", () => {
  it("heads the wallet with its state, balance and identity, then what it holds and did", async () => {
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(
      await screen.findByText("$4,000.00", { selector: "[data-wallet-balance]" })
    ).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Payments can sign with this wallet.")).toBeTruthy();
    expect(screen.getByText("Fireblocks")).toBeTruthy();
    expect(screen.getByText("Transfers")).toBeTruthy();
    // The facts under the balance, label over value, in the design's order.
    expect(
      [...document.querySelectorAll("[data-record-fact] dt")].map((label) => label.textContent)
    ).toEqual(["Provider", "Purpose", "Created", "Address", "Wallet ID"]);

    const tokens = await waitFor(() =>
      present(document.querySelector<HTMLElement>("[data-wallet-tokens]"), "the tokens table")
    );
    expect(within(tokens).getByText("USDC")).toBeTruthy();
    // The mint under its token, with a copy of the whole.
    expect(
      within(tokens).getByText("EPjF...Dt1v").closest("[data-wallet-token-mint]")
    ).toBeTruthy();
    expect(within(tokens).getByRole("button", { name: "Copy usdc mint" })).toBeTruthy();

    const activity = await waitForActivityTable();
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("xfr_7c1c…c1c7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View all activity" }));
    expect(mocks.replaceSearchParams).toHaveBeenCalledWith({ tab: "activity" });
  });

  it("puts the connection beside the provider and names it in the band", async () => {
    await act(async () => {
      renderView({
        wallet: { ...WALLET_FIELDS, provider: "privy", custodyConnectionId: "conn_test_treasury" },
        connection: { label: "Treasury app", href: "/dashboard/prj/integrations/privy/c" },
      });
    });
    expect(
      await screen.findByText("Payments can sign with this wallet. It signs through Treasury app.")
    ).toBeTruthy();
    expect(
      [...document.querySelectorAll("[data-record-fact] dt")].map((label) => label.textContent)
    ).toEqual(["Provider", "Connection", "Purpose", "Created", "Address", "Wallet ID"]);
    expect(screen.getByRole("link", { name: "Treasury app" }).getAttribute("href")).toBe(
      "/dashboard/prj/integrations/privy/c"
    );
    expect(
      screen.getByRole("button", {
        name: "The Privy account this wallet was created in. It signs only through this connection.",
      })
    ).toBeTruthy();
  });

  it("opens a row to its signature, the address on the other side and the explorer", async () => {
    mocks.activity = {
      ...mocks.activity,
      activityRows: [
        { ...OUTGOING_ROW, signature: "5VERYlongSignature1111111111111111abcdefgh" },
        INCOMING_ROW,
      ],
    };
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    const activity = await waitForActivityTable();
    const toggles = within(activity).getAllByRole("button", { name: "Details" });
    const openFirst = present(toggles[0], "the first row's Details");
    const openSecond = present(toggles[1], "the second row's Details");
    expect(openFirst.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(openFirst);
    expect(openFirst.getAttribute("aria-expanded")).toBe("true");
    const details = openRowDetails();
    expect(within(details).getByText("5VERYlon...abcdefgh")).toBeTruthy();
    expect(within(details).getByText("Counterparty address")).toBeTruthy();
    expect(within(details).getByRole("button", { name: "Copy signature" })).toBeTruthy();
    expect(
      within(details).getByRole("link", { name: "View on explorer" }).getAttribute("href")
    ).toContain("5VERYlongSignature1111111111111111abcdefgh");

    // One row open at a time; a row with no signature yet says so and offers no explorer.
    fireEvent.click(openSecond);
    expect(openFirst.getAttribute("aria-expanded")).toBe("false");
    const pending = openRowDetails();
    expect(within(pending).getByText("None yet")).toBeTruthy();
    expect(within(pending).queryByRole("link", { name: "View on explorer" })).toBeNull();
  });

  it("keeps the recent rows when a refresh fails, and says the activity is unavailable", async () => {
    mocks.activityRefreshFails = true;
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    const activity = await waitForActivityTable();
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();
  });

  it("says a restricted wallet cannot sign, and offers no faucet", async () => {
    await act(async () => {
      renderView({ wallet: { ...wallet, isRuntimeExecutionAllowed: false }, connection: null });
    });
    expect(await screen.findByText("Restricted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request devnet SOL" })).toBeNull();
  });
});

describe("Activity", () => {
  it("searches the wallet's activity", async () => {
    mocks.tab = "activity";
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(await screen.findAllByText(/xfr_/)).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("Search this wallet's activity"), {
      target: { value: "a046" },
    });
    expect(screen.getAllByText(/xfr_/)).toHaveLength(1);
    expect(document.querySelector("[data-wallet-activity-capped]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
    // The wallet's ledger is one press away whether or not older rows remain: in the toolbar,
    // and under the list on a phone.
    for (const link of screen.getAllByRole("link", { name: "Open in Transactions" })) {
      expect(link.getAttribute("href")).toBe(
        "/dashboard/prj_test_sandbox/payments/transactions?custodyWalletId=cwlt_one"
      );
    }
  });

  it("keeps the loaded rows when a refresh fails, and says the activity is unavailable", async () => {
    mocks.tab = "activity";
    mocks.activityRefreshFails = true;
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    expect(screen.getAllByText(/xfr_/)).toHaveLength(2);
  });

  it("loads older activity and points the full history at this wallet's ledger", async () => {
    mocks.tab = "activity";
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 20 }, (_, index) => ({
        ...OUTGOING_ROW,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(
      await screen.findByText(
        /Search and filters cover the latest 20 transactions loaded here\. The full history is in Transactions\./
      )
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open in Transactions" })).toHaveLength(2);
    expect(mocks.activityLimits.at(-1)).toBe(20);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    });
    expect(mocks.activityLimits.at(-1)).toBe(120);
  });

  it("keeps the loaded rows when older activity fails, and retries the same window", async () => {
    mocks.tab = "activity";
    mocks.widerActivityFails = true;
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 20 }, (_, index) => ({
        ...OUTGOING_ROW,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Load older activity" }));
    });
    expect(
      screen.getByText("Older activity didn't load. The latest 20 transactions are still shown.")
    ).toBeTruthy();
    expect(screen.getAllByText(/xfr_row_/)).toHaveLength(20);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try loading older activity again" }));
    });
    expect(mocks.retryActivity).toHaveBeenCalledTimes(1);
    expect(Math.max(...mocks.activityLimits.map((limit) => limit ?? 20))).toBe(120);
  });

  it("offers older activity only from the last page of what is loaded", async () => {
    mocks.tab = "activity";
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 30 }, (_, index) => ({
        ...OUTGOING_ROW,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    expect(await screen.findByText("Page 1 of 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeTruthy();
  });
});

describe("Settings", () => {
  it("saves a changed label only, and proves ownership where the wallet can sign", async () => {
    mocks.tab = "settings";
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    const field = await screen.findByLabelText("Wallet label");
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(field).toHaveProperty("value", "Settlement Fireblocks");
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "Treasury" } });
    expect(save).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Prove ownership" })).toHaveProperty(
      "disabled",
      false
    );
  });

  it("keeps a label, holds purpose and creation as fixed, and reads Never before a proof", async () => {
    mocks.tab = "settings";
    await act(async () => {
      renderView({ wallet, connection: null });
    });
    const field = await screen.findByLabelText("Wallet label");
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(
        "Give the wallet a label. Without one it reads as Untitled wallet everywhere it appears."
      )
    ).toBeTruthy();

    const fixed = present(
      screen.getByRole("heading", { name: "Fixed at creation" }).closest("section"),
      "the Fixed at creation block"
    );
    expect([...fixed.querySelectorAll("dt")].map((label) => label.textContent)).toEqual([
      "Purpose",
      "Created",
    ]);
    expect(screen.getByText("Last proof")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("explains why a restricted wallet cannot prove ownership", async () => {
    mocks.tab = "settings";
    await act(async () => {
      renderView({ wallet: { ...wallet, isRuntimeExecutionAllowed: false }, connection: null });
    });
    expect(await screen.findByRole("button", { name: "Prove ownership" })).toHaveProperty(
      "disabled",
      true
    );
    expect(
      screen.getByText("This wallet cannot sign right now, so the check cannot run.")
    ).toBeTruthy();
  });
});
