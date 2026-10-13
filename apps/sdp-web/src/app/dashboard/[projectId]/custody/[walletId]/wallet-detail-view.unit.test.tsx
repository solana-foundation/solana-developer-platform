// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

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
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
  }),
}));
vi.mock("@/app/dashboard/[projectId]/custody/actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: vi.fn(),
  updateWalletLabelAction: vi.fn(),
}));
vi.mock("@/app/dashboard/[projectId]/custody/wallet-provider-mark", () => ({
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

const wallet: ComponentProps<typeof WalletDetailView>["wallet"] = {
  walletId: "wallet_one",
  custodyWalletId: "cwlt_one",
  name: "Settlement Fireblocks",
  label: "Settlement Fireblocks",
  publicKey: "gZeTc7Hq9mXw2JDUBSDgZeTc7Hq9mXw2JDUBSD",
  provider: "fireblocks",
  providerName: "Fireblocks",
  purposeLabel: "Transfers",
  createdAt: "2026-06-30T00:00:00.000Z",
  isRuntimeExecutionAllowed: true,
  supportsSignerCheck: true,
  connection: null,
  canManageCustody: true,
};

function renderView(overrides: Partial<ComponentProps<typeof WalletDetailView>> = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletDetailView
        wallet={wallet}
        balancesPromise={Promise.resolve({
          balances: [
            {
              token: "USDC",
              mint: USDC,
              amount: "4000000000",
              uiAmount: "4000",
              decimals: 6,
              usdValue: 4000,
            },
          ],
          error: null,
        })}
        issuedTokensPromise={Promise.resolve({})}
        issuanceEnabled
        {...overrides}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.tab = null;
  mocks.activity = {
    activityRows: [
      {
        id: "payment-xfr_7c1c0000c1c7",
        sourceKind: "payments",
        operationLabel: "Outgoing",
        status: "finalized",
        signature: null,
        token: USDC,
        amount: "500.00",
        address: "Dq73aaaaaaaaaaaaaaaaaaaa2KCh",
        createdAt: "2026-09-11T00:00:00.000Z",
      },
      {
        id: "payment-xfr_a0460000a2a63",
        sourceKind: "payments",
        operationLabel: "Incoming",
        status: "pending",
        signature: null,
        token: USDC,
        amount: "1250.00",
        address: "FSegbbbbbbbbbbbbbbbbbb2WSY",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    ],
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
});

describe("Overview", () => {
  it("heads the wallet with its state, balance and identity, then what it holds and did", async () => {
    await act(async () => {
      renderView();
    });
    expect(
      await screen.findByText("$4,000.00", { selector: "[data-wallet-balance]" })
    ).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Fireblocks")).toBeTruthy();
    expect(screen.getByText("Transfers")).toBeTruthy();

    const tokens = document.querySelector("[data-wallet-tokens]") as HTMLElement;
    expect(within(tokens).getByText("USDC")).toBeTruthy();

    const activity = document.querySelector("[data-wallet-activity-table]") as HTMLElement;
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("xfr_7c1c…c1c7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View all activity" }));
    expect(mocks.replaceSearchParams).toHaveBeenCalledWith({ tab: "activity" });
  });

  it("keeps the recent rows when a refresh fails, and says the activity is unavailable", async () => {
    mocks.activityRefreshFails = true;
    await act(async () => {
      renderView();
    });
    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    const activity = document.querySelector("[data-wallet-activity-table]") as HTMLElement;
    expect(within(activity).getByText("−500.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("+1250.00 USDC")).toBeTruthy();
  });

  it("says a restricted wallet cannot sign, and offers no faucet", async () => {
    await act(async () => {
      renderView({ wallet: { ...wallet, isRuntimeExecutionAllowed: false } });
    });
    expect(await screen.findByText("Restricted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request devnet SOL" })).toBeNull();
  });
});

describe("Activity", () => {
  it("searches the wallet's activity", async () => {
    mocks.tab = "activity";
    await act(async () => {
      renderView();
    });
    expect(await screen.findAllByText(/xfr_/)).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("Search this wallet's activity"), {
      target: { value: "a046" },
    });
    expect(screen.getAllByText(/xfr_/)).toHaveLength(1);
    expect(document.querySelector("[data-wallet-activity-capped]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
  });

  it("keeps the loaded rows when a refresh fails, and says the activity is unavailable", async () => {
    mocks.tab = "activity";
    mocks.activityRefreshFails = true;
    await act(async () => {
      renderView();
    });
    expect(await screen.findByText("Wallet activity is unavailable right now.")).toBeTruthy();
    expect(screen.getAllByText(/xfr_/)).toHaveLength(2);
  });

  it("loads older activity and points the full history at this wallet's ledger", async () => {
    mocks.tab = "activity";
    const [first] = mocks.activity.activityRows as { id: string }[];
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 20 }, (_, index) => ({
        ...first,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView();
    });
    expect(
      await screen.findByText(
        /Search and filters cover the latest 20 transactions loaded here\. The full history is in Transactions\./
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Transactions" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/payments/transactions?custodyWalletId=cwlt_one"
    );
    expect(mocks.activityLimits.at(-1)).toBe(20);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    });
    expect(mocks.activityLimits.at(-1)).toBe(120);
  });

  it("keeps the loaded rows when older activity fails, and retries the same window", async () => {
    mocks.tab = "activity";
    mocks.widerActivityFails = true;
    const [first] = mocks.activity.activityRows as { id: string }[];
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 20 }, (_, index) => ({
        ...first,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView();
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
    const [first] = mocks.activity.activityRows as { id: string }[];
    mocks.activity = {
      ...mocks.activity,
      activityRows: Array.from({ length: 30 }, (_, index) => ({
        ...first,
        id: `payment-xfr_row_${index}`,
      })),
      hasMore: true,
    };
    await act(async () => {
      renderView();
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
      renderView();
    });
    const field = (await screen.findByLabelText("Wallet label")) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(field.value).toBe("Settlement Fireblocks");
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Treasury" } });
    expect(save.disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Prove ownership" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("explains why a restricted wallet cannot prove ownership", async () => {
    mocks.tab = "settings";
    await act(async () => {
      renderView({ wallet: { ...wallet, isRuntimeExecutionAllowed: false } });
    });
    const prove = (await screen.findByRole("button", {
      name: "Prove ownership",
    })) as HTMLButtonElement;
    expect(prove.disabled).toBe(true);
    expect(
      screen.getByText("This wallet cannot sign right now, so the check cannot run.")
    ).toBeTruthy();
  });
});
