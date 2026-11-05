// @vitest-environment jsdom

import type { Counterparty, CounterpartyAccount } from "@sdp/types/counterparties";
import {
  type PaymentRecurringPayment,
  type PaymentSubscriptionCollectionAttempt,
  type PaymentsDashboardWallet,
  RECURRING_PAYMENT_COLLECTION_CONFIG,
  RECURRING_PAYMENT_PAUSE_REASONS,
  type RecurringPaymentPauseReason,
} from "@sdp/types/payments";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { sentDashboardRequests, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { RecurringPaymentCreateWorkspace } from "./recurring-payment-create-workspace";
import {
  RecurringPaymentDetailRoute,
  RecurringPaymentDetailWorkspace,
} from "./recurring-payment-detail-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
  setDashboardUrl("/dashboard/prj_test_sandbox/payments/recurring/prp_test", {
    recurringPaymentId: "prp_test",
  });
});
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
    dashboardAccess: { capabilities: { canWrite: true } },
    flags: { custody: true },
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const source: PaymentsDashboardWallet = {
  id: "cwlt_source",
  walletId: "privy_shared",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  custodyConfigId: "ccfg_test",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: MINT, amount: "10000000", uiAmount: "10", decimals: 6 }],
};
const recurring: PaymentRecurringPayment & { sourceCustodyWalletId: string } = {
  id: "prp_test",
  organizationId: "org_test",
  projectId: "proj_test",
  sourceCustodyWalletId: source.id,
  sourceProviderWalletId: source.walletId,
  sourceAddress: source.publicKey,
  counterpartyId: "cpty_receiver",
  counterpartyAccountId: "cpa_receiver",
  destinationAddress: source.publicKey,
  destinationTokenAccount: null,
  token: MINT,
  amount: "1",
  periodHours: 24,
  firstCollectionAt: null,
  nextCollectionDueAt: null,
  planId: null,
  subscriptionId: null,
  planPda: null,
  planCreatedAt: null,
  planCreationSignature: null,
  subscriptionPda: null,
  subscriptionAuthorityAddress: null,
  authorizationSignature: null,
  status: "active",
  pausedReason: null,
  metadataUri: null,
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};
const counterparty: Counterparty = {
  id: "cpty_receiver",
  organizationId: "org_test",
  projectId: "proj_test",
  externalId: null,
  displayName: "Receiver",
  entityType: "business",
  status: "active",
  createdBy: null,
  createdAt: recurring.createdAt,
  updatedAt: recurring.updatedAt,
};
const account: CounterpartyAccount = {
  id: "cpa_receiver",
  organizationId: "org_test",
  projectId: "proj_test",
  counterpartyId: counterparty.id,
  accountKind: "crypto_wallet",
  label: "Receiving wallet",
  details: { address: source.publicKey },
  providerAccountData: {},
  status: "active",
  createdAt: recurring.createdAt,
  updatedAt: recurring.updatedAt,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Recurring Payment exact source selection", () => {
  it("saves a pending payment with a Connection wallet even when signing is unavailable", async () => {
    const unavailable: PaymentsDashboardWallet = {
      id: source.id,
      walletId: source.walletId,
      publicKey: source.publicKey,
      label: source.label,
      custodyConnectionId: "ccon_test",
      isRuntimeExecutionAllowed: false,
      balances: source.balances,
    };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [unavailable] } });
      if (init?.method === "POST") writes.push(JSON.parse(String(init.body)));
      return Response.json({
        data: {
          counterparties: [counterparty],
          accounts: [account],
          total: 1,
          page: 1,
          pageSize: 100,
          recurringPayment: { ...recurring, status: "pending_activation" },
        },
      });
    });
    render(<RecurringPaymentCreateWorkspace issuanceEnabled={false} />, { wrapper });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Contact" }));
    await user.click(screen.getByRole("button", { name: /Receiver/ }));
    // The contact's only Solana address is the destination; no field asks for it.
    await user.click(screen.getByRole("button", { name: "Source wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    expect(screen.getByText(/Signing is disabled for this wallet\./)).toBeTruthy();
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "1");
    const next = () => screen.getByRole("button", { name: "Continue" });
    await waitFor(() => expect(next().hasAttribute("disabled")).toBe(false));
    await user.click(next());
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Create the schedule" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      sourceCustodyWalletId: source.id,
      counterpartyAccountId: account.id,
      amount: "1",
    });
  });

  it.each(["current", "replacement"])(
    "prevents active source replacement when the %s wallet cannot sign",
    async (unavailableWallet) => {
      const currentSource = {
        ...source,
        isRuntimeExecutionAllowed: unavailableWallet !== "current",
      };
      const replacement = {
        ...source,
        id: "cwlt_replacement",
        label: "Replacement",
        isRuntimeExecutionAllowed: unavailableWallet !== "replacement",
      };
      const writes: unknown[] = [];
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body)));
        return Response.json({
          data: { wallets: [currentSource, replacement], recurringPayment: recurring },
        });
      });
      render(
        <RecurringPaymentDetailWorkspace
          recurringPayment={recurring}
          wallet={currentSource}
          wallets={[currentSource, replacement]}
          issuedTokensByMint={{}}
          counterpartyAccounts={[]}
          counterpartyLabel="Receiver"
          collectionAttempts={[]}
          collectionAttemptsTotal={0}
        />,
        { wrapper }
      );
      const user = userEvent.setup();
      if (unavailableWallet === "current") {
        // Nothing about an active payment can be saved without its wallet's
        // signature, so there is no Edit and the band carries the reason.
        await waitFor(() =>
          expect(
            screen.getByText(
              /You cannot collect, change, or cancel this schedule until signing is enabled for Treasury/
            )
          ).toBeTruthy()
        );
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
        return;
      }
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.click(screen.getByRole("button", { name: "Funding wallet" }));
      // A restricted replacement is listed and badged, but not on offer: the
      // click changes nothing and the current wallet stays selected.
      const replacementOption = screen.getByRole("button", { name: /Replacement/ });
      expect(replacementOption.getAttribute("aria-disabled")).toBe("true");
      expect(replacementOption.textContent).toContain("Restricted");
      fireEvent.click(replacementOption);
      expect(screen.getByRole("button", { name: /Replacement/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Funding wallet" }).textContent).toContain(
        "Treasury"
      );
      await waitFor(() => expect(writes).toEqual([]));
    }
  );

  it.each([
    ["holds the schedule's token", MINT, true],
    ["holds only another token", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", false],
  ])("switching to a wallet that %s", async (_case, replacementMint, keepsToken) => {
    const replacement = {
      ...source,
      id: "cwlt_replacement",
      label: "Replacement",
      balances: [
        {
          token: keepsToken ? "USDC" : "USDT",
          mint: replacementMint,
          amount: "10000000",
          uiAmount: "10",
          decimals: 6,
        },
      ],
    };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body)));
      return Response.json({
        data: { wallets: [source, replacement], recurringPayment: recurring },
      });
    });
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={recurring}
        wallet={source}
        wallets={[source, replacement]}
        issuedTokensByMint={{}}
        counterpartyAccounts={[account]}
        counterpartyLabel="Receiver"
        collectionAttempts={[]}
        collectionAttemptsTotal={0}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Funding wallet" }));
    await user.click(await screen.findByRole("button", { name: /Replacement/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    if (keepsToken) {
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toEqual({ sourceCustodyWalletId: replacement.id });
      return;
    }
    // The old token is not the new wallet's to pay with: the picker clears and the form asks
    // for one, as its placeholder and its error, instead of saving the pair.
    expect(screen.getByRole("button", { name: "Token" }).textContent).toContain(
      "Select a currency."
    );
    expect(await screen.findAllByText("Select a currency.")).toHaveLength(2);
    expect(writes).toEqual([]);
  });
});

describe("Recurring Payment detail read", () => {
  it("shows the Project's not-found page for a schedule the API does not hold", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      String(input).startsWith("/api/dashboard/payments/recurring-payments/prp_test")
        ? Response.json({ error: { message: "Recurring payment not found" } }, { status: 404 })
        : Response.json({ data: { wallets: [source] } })
    );
    render(<RecurringPaymentDetailRoute recurringPaymentId="prp_test" issuanceEnabled={false} />, {
      wrapper,
    });

    expect(await screen.findByRole("link", { name: "Back to Overview" })).toBeTruthy();
  });
});

describe("Recurring Payment lifecycle actions", () => {
  const lastRunError =
    "Privy blocked signing due to a wallet policy. Review the policy in Privy or adjust the request.";
  const pausedCopy = {
    destination_unavailable:
      "SDP paused this schedule because its recipient or account is no longer available. Cancel it and create a new schedule with an active recipient.",
    failed_attempts: `SDP paused this schedule because its runs kept failing: one run failed ${RECURRING_PAYMENT_COLLECTION_CONFIG.maxFailedAttemptsBeforePause} times. Nothing runs while it is paused. Fix the cause, then resume it, or cancel it.`,
    custody_policy_refused:
      "SDP paused this schedule because the custody provider's policy refused it. Nothing runs while it is paused. Review the wallet's policy and payment details, then resume or cancel it.",
  } satisfies Record<RecurringPaymentPauseReason, string>;
  const failedRun: PaymentSubscriptionCollectionAttempt = {
    id: "pcat_failed",
    organizationId: "org_test",
    projectId: "proj_test",
    subscriptionId: "psub_test",
    transferId: null,
    token: MINT,
    amount: "1",
    dueAt: "2026-09-20T00:00:00.000Z",
    attemptedAt: "2026-09-20T00:05:00.000Z",
    status: "failed",
    signature: null,
    error: lastRunError,
    metadata: { source: "automated", recurringPaymentId: recurring.id, initiatedByKeyId: null },
    createdAt: "2026-09-20T00:05:00.000Z",
    updatedAt: "2026-09-20T00:05:00.000Z",
  };

  function renderDetail(
    recurringPayment: typeof recurring,
    collectionAttempts: PaymentSubscriptionCollectionAttempt[]
  ) {
    vi.stubGlobal("fetch", async () => Response.json({ data: { wallets: [source] } }));
    renderDetailWorkspace(recurringPayment, collectionAttempts);
  }

  function renderDetailWorkspace(
    recurringPayment: typeof recurring,
    collectionAttempts: PaymentSubscriptionCollectionAttempt[]
  ) {
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={recurringPayment}
        wallet={source}
        wallets={[source]}
        issuedTokensByMint={{}}
        counterpartyAccounts={[account]}
        counterpartyLabel="Receiver"
        collectionAttempts={collectionAttempts}
        collectionAttemptsTotal={collectionAttempts.length}
      />,
      { wrapper }
    );
  }

  it.each(RECURRING_PAYMENT_PAUSE_REASONS)(
    "shows the available actions on a schedule paused for %s, naming its reason and last failure",
    async (pausedReason) => {
      renderDetail({ ...recurring, status: "paused", pausedReason, subscriptionId: "psub_test" }, [
        failedRun,
      ]);
      expect(await screen.findByText(pausedCopy[pausedReason])).toBeTruthy();
      expect(screen.getByText(`Last run: ${lastRunError}`)).toBeTruthy();
      if (pausedReason === "destination_unavailable") {
        expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
      } else {
        expect(
          screen.getByRole("button", { name: "Resume schedule" }).getAttribute("data-variant")
        ).toBe("default");
      }
      expect(
        screen.getByRole("button", { name: "Cancel schedule" }).getAttribute("data-variant")
      ).toBe("outline");
    }
  );

  it("shows the last failure without repeating its label while a schedule remains active", () => {
    renderDetail({ ...recurring, status: "active", subscriptionId: "psub_test" }, [failedRun]);
    expect(screen.getByText("Last run failed")).toBeTruthy();
    const failureNotice = screen.getByText(
      "Schedule is active. Review the failure below before retrying."
    );
    expect(failureNotice.textContent).toContain(lastRunError);
    expect(screen.queryByText(`Last run: ${lastRunError}`)).toBeNull();
  });

  it("clears the failure band after a later successful collection", () => {
    renderDetail({ ...recurring, status: "active", subscriptionId: "psub_test" }, [
      failedRun,
      {
        ...failedRun,
        id: "pcat_recovered",
        attemptedAt: "2026-09-20T00:10:00.000Z",
        status: "confirmed",
        error: null,
      },
    ]);
    expect(screen.queryByText("Last run failed")).toBeNull();
    expect(
      screen.queryByText("Schedule is active. Review the failure below before retrying.")
    ).toBeNull();
  });

  it("a canceled schedule offers no lifecycle action", async () => {
    renderDetail({ ...recurring, status: "canceled", subscriptionId: "psub_test" }, [failedRun]);
    expect(
      await screen.findByText("This schedule will not run again. Its past runs keep their record.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel schedule" })).toBeNull();
  });

  const outcomeUnknown = () =>
    Response.json(
      { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "outcome unknown" } },
      { status: 409 }
    );

  async function runAction(schedule: typeof recurring, label: string, answer: () => Response) {
    const fetchMock = stubDashboardFetch(({ method }) =>
      method === "POST" ? answer() : Response.json({ data: { wallets: [source] } })
    );
    const walletReads = () =>
      sentDashboardRequests(fetchMock).filter(
        (request) => request.method === "GET" && request.path.startsWith("/api/dashboard/wallets")
      ).length;
    renderDetailWorkspace(schedule, []);
    const button = await screen.findByRole("button", { name: label });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    const before = walletReads();

    fireEvent.click(button);

    await waitFor(() => expect(walletReads()).toBeGreaterThan(before));
  }

  it.each<{ label: string; schedule: typeof recurring }>([
    { label: "Activate schedule", schedule: { ...recurring, status: "pending_activation" } },
    {
      label: "Collect now",
      schedule: {
        ...recurring,
        subscriptionId: "psub_test",
        nextCollectionDueAt: "2020-01-01T00:00:00.000Z",
      },
    },
    {
      label: "Resume schedule",
      schedule: {
        ...recurring,
        status: "paused",
        pausedReason: "failed_attempts",
        subscriptionId: "psub_test",
      },
    },
  ])("reads the balances again once $label succeeds", async ({ label, schedule }) => {
    await runAction(schedule, label, () => Response.json({ data: { recurringPayment: schedule } }));
  });

  it("reads the balances again when a collection's outcome is unknown", async () => {
    await runAction(
      {
        ...recurring,
        subscriptionId: "psub_test",
        nextCollectionDueAt: "2020-01-01T00:00:00.000Z",
      },
      "Collect now",
      outcomeUnknown
    );
  });
});
