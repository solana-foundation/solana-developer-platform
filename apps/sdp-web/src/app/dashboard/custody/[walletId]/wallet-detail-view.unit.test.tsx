// @vitest-environment jsdom

import type { PaymentWalletPolicy } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

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
  retryActivity: vi.fn(),
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
      return { data: mocks.activity, error: undefined, isValidating: false, mutate: vi.fn() };
    },
  };
});

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
      "/dashboard/payments/transactions?custodyWalletId=cwlt_one"
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
