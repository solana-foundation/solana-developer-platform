// @vitest-environment jsdom

import type {
  PaymentWalletPolicy,
  UnifiedTransaction,
  UnifiedTransactionsListResponse,
} from "@sdp/types";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { WalletTransactionsQuery } from "./use-wallet-transactions";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const mocks = vi.hoisted(() => ({
  tab: null as string | null,
  replaceSearchParams: vi.fn(),
  refresh: vi.fn(),
  transactions: {
    transactions: [] as unknown[],
    nextCursor: null as string | null,
  },
  /** Every page the view asked the feed for, in order. */
  queries: [] as unknown[],
  /** The page's latest refresh fails, so SWR holds its rows and an error. */
  activityRefreshFails: false,
  /** The feed refuses the caller: no module permission at all. */
  activityForbidden: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  usePathname: () => "/dashboard/wallets/wallet_one",
}));
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
vi.mock("@/app/dashboard/custody/actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: vi.fn(),
  updateWalletLabelAction: vi.fn(),
}));
vi.mock("@/app/dashboard/payments/payments-workspace.data", () => ({
  updateWalletPolicy: vi.fn(),
}));
vi.mock("@/app/dashboard/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span data-testid="mark" />,
}));
vi.mock("./use-wallet-transactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-wallet-transactions")>();
  return {
    ...actual,
    useWalletTransactions: (query: WalletTransactionsQuery) => {
      mocks.queries.push(query);
      if (mocks.activityForbidden) {
        return {
          data: undefined,
          error: new actual.WalletTransactionsError("Forbidden", 403),
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      return {
        data: mocks.transactions as UnifiedTransactionsListResponse,
        error: mocks.activityRefreshFails ? new Error("Activity refresh failed") : undefined,
        isValidating: false,
        mutate: vi.fn(),
      };
    },
  };
});

function lastQuery(): WalletTransactionsQuery {
  return mocks.queries.at(-1) as WalletTransactionsQuery;
}

function paymentRow(
  id: string,
  kind: "pay" | "deposit",
  changes: Partial<UnifiedTransaction> = {}
): UnifiedTransaction {
  return {
    id,
    moduleId: id,
    module: "payments",
    kind,
    moduleStatus: "finalized",
    status: "succeeded",
    organizationId: "org",
    projectId: "project",
    custodyWalletId: "cwlt_one",
    custodyWalletLabel: "Treasury",
    token: USDC,
    amount: "500.00",
    counterpartyId: null,
    counterpartyAddress: "Dq73aaaaaaaaaaaaaaaaaaaa2KCh",
    signature: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    ...changes,
  } as UnifiedTransaction;
}

const { WalletDetailView } = await import("./wallet-detail-view");

const policy: PaymentWalletPolicy = {
  walletId: "wallet_one",
  defaultAction: "allow",
  rules: [
    { kind: "amount", max: "5000", asset: USDC },
    { kind: "destination", allowlist: ["Addr1111", "Addr2222"] },
    { kind: "operation_family", families: ["ramp"], action: "deny" },
  ],
  controlProfile: {
    id: "profile",
    status: "active",
    activeRevisionId: "rev_2",
    revisionId: "rev_2",
    revisionNumber: 2,
    commitMessage: null,
    defaultAction: "allow",
    rules: [],
    providerMappingStatus: "not_applicable",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    activatedAt: "2026-08-12T12:00:00.000Z",
  },
  audit: {
    recentEvaluations: [
      {
        walletOperationId: "op_1",
        policyEvaluationId: "ev_1",
        operationFamily: "payment",
        operationType: "payment_transfer_execute",
        asset: USDC,
        amount: "2400.00",
        destination: null,
        status: "completed",
        decision: "allow",
        reasonCode: "wallet_policy_match",
        reason: null,
        requiresApproval: false,
        approvalRequestId: null,
        operationCreatedAt: "2026-09-07T00:00:00.000Z",
        operationUpdatedAt: "2026-09-07T00:00:00.000Z",
        evaluatedAt: "2026-09-07T00:00:00.000Z",
      },
    ],
  },
} as PaymentWalletPolicy;

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
        policyPromise={Promise.resolve({ policy, error: null })}
        revisionsPromise={Promise.resolve({
          history: {
            profile: null,
            revisions: [
              {
                id: "rev_2",
                profileId: "profile",
                revisionNumber: 2,
                rules: [],
                defaultAction: "allow",
                commitMessage: null,
                createdBy: "user_dana",
                createdAt: "2026-08-12T00:00:00.000Z",
                activatedAt: "2026-08-12T12:00:00.000Z",
                isActive: true,
              },
            ],
          },
          userNames: { user_dana: "Dana Whitfield" },
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
  mocks.transactions = {
    transactions: [
      paymentRow("xfr_7c1c0000c1c7", "pay"),
      paymentRow("xfr_a0460000a2a63", "deposit", {
        moduleStatus: "pending",
        status: "pending",
        amount: "1250.00",
        counterpartyAddress: "FSegbbbbbbbbbbbbbbbbbb2WSY",
        createdAt: "2026-09-10T00:00:00.000Z",
      }),
    ],
    nextCursor: null,
  };
  mocks.queries = [];
  mocks.activityRefreshFails = false;
  mocks.activityForbidden = false;
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
    expect(within(activity).getByText("+1,250.00 USDC")).toBeTruthy();
    expect(within(activity).getByText("xfr_7c1c…c1c7")).toBeTruthy();
    expect(within(activity).getByText("Pay")).toBeTruthy();
    expect(within(activity).getByText("Deposit")).toBeTruthy();
    // The Overview reads the wallet's five newest rows from the same feed the Activity tab pages.
    expect(lastQuery()).toEqual({ custodyWalletId: "cwlt_one", limit: 5 });

    expect(
      screen.getByText(
        "Sends up to 5000 USDC, only to 2 allowed addresses, Ramp refused. Revision #2, enforcing since Aug 12, 2026."
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit policy" }).getAttribute("href")).toBe(
      "/dashboard/wallets/wallet_one/policy"
    );

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
    expect(within(activity).getByText("+1,250.00 USDC")).toBeTruthy();
  });

  it("says when the caller may read no activity at all", async () => {
    mocks.activityForbidden = true;
    await act(async () => {
      renderView();
    });
    expect(
      await screen.findByText("No activity sources are available for this wallet.")
    ).toBeTruthy();
  });

  it("says a restricted wallet cannot sign, and offers no faucet", async () => {
    await act(async () => {
      renderView({ wallet: { ...wallet, isRuntimeExecutionAllowed: false } });
    });
    expect(await screen.findByText("Restricted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request devnet SOL" })).toBeNull();
  });

  it("leaves the policy out where Policies is off, even when asked for its tab", async () => {
    mocks.tab = "policy";
    await act(async () => {
      renderView({ policyPromise: null, revisionsPromise: null });
    });
    expect(document.querySelector('[data-wallet-detail="overview"]')).toBeTruthy();
    expect(screen.queryByText("Edit policy")).toBeNull();
  });
});

describe("Activity", () => {
  it("sends a search of three or more characters to the API, from the newest page", async () => {
    mocks.tab = "activity";
    mocks.transactions = { ...mocks.transactions, nextCursor: "cursor_2" };
    await act(async () => {
      renderView();
    });
    expect(await screen.findAllByText(/xfr_/)).toHaveLength(2);
    expect(lastQuery()).toEqual({ custodyWalletId: "cwlt_one", limit: 25 });
    const search = screen.getByPlaceholderText("Search ID, signature or address (3+ characters)");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(lastQuery().cursor).toBe("cursor_2");

    fireEvent.change(search, { target: { value: "a0" } });
    expect(lastQuery().search).toBeUndefined();

    fireEvent.change(search, { target: { value: "a046" } });
    expect(lastQuery()).toMatchObject({ search: "a046", cursor: undefined });

    fireEvent.change(search, { target: { value: "" } });
    expect(lastQuery().search).toBeUndefined();
  });

  it("pages the wallet's whole history with the feed's cursor", async () => {
    mocks.tab = "activity";
    mocks.transactions = { ...mocks.transactions, nextCursor: "cursor_2" };
    await act(async () => {
      renderView();
    });
    expect(await screen.findByText("Page 1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(lastQuery().cursor).toBe("cursor_2");
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(lastQuery().cursor).toBeUndefined();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("shows no pager while the feed has one page, and the empty note when it has none", async () => {
    mocks.tab = "activity";
    await act(async () => {
      renderView();
    });
    expect(await screen.findAllByText(/xfr_/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    cleanup();

    mocks.transactions = { transactions: [], nextCursor: null };
    await act(async () => {
      renderView();
    });
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
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
});

describe("Policy", () => {
  it("shows the revision enforcing, the rules, revisions and latest decisions", async () => {
    mocks.tab = "policy";
    await act(async () => {
      renderView();
    });
    expect(
      await screen.findByText("Revision #2 has been enforcing since Aug 12, 2026.")
    ).toBeTruthy();
    expect(screen.getByText("Allow list · 2 addresses")).toBeTruthy();
    expect(screen.getByText("Ramp refused")).toBeTruthy();
    const revisions = document.querySelector("[data-wallet-revisions]") as HTMLElement;
    expect(within(revisions).getByText("Dana Whitfield")).toBeTruthy();
    const decisions = document.querySelector("[data-wallet-decisions]") as HTMLElement;
    expect(within(decisions).getByText("payment_transfer_execute")).toBeTruthy();
    expect(within(decisions).getByText("2400.00 USDC")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open policy decisions" }).getAttribute("href")).toBe(
      "/dashboard/wallets/wallet_one/policy/audit"
    );
    expect(screen.getByRole("button", { name: "Disable policy…" })).toBeTruthy();
  });

  it("reaches the policy's history from its revisions before it has made a decision", async () => {
    mocks.tab = "policy";
    await act(async () => {
      renderView({
        policyPromise: Promise.resolve({
          policy: { ...policy, audit: { recentEvaluations: [] } } as PaymentWalletPolicy,
          error: null,
        }),
      });
    });
    await screen.findByText("Revision #2 has been enforcing since Aug 12, 2026.");
    expect(document.querySelector("[data-wallet-decisions]")).toBeNull();
    expect(screen.getByRole("link", { name: "Policy audit" }).getAttribute("href")).toBe(
      "/dashboard/wallets/wallet_one/policy/audit"
    );
  });

  it("keeps Disable away from someone who cannot manage custody", async () => {
    mocks.tab = "policy";
    await act(async () => {
      renderView({ wallet: { ...wallet, canManageCustody: false } });
    });
    await screen.findByText("Revision #2 has been enforcing since Aug 12, 2026.");
    expect(screen.queryByRole("button", { name: "Disable policy…" })).toBeNull();
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
