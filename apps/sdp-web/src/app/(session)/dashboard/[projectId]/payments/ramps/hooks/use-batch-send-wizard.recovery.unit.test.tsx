// @vitest-environment jsdom

import type { CounterpartyAccountSummary, PaymentsDashboardWallet } from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import { resetTransferBatchIdempotencyStateForTests } from "@/app/(session)/dashboard/[projectId]/payments/transfer-batch-idempotency";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardKeyScope, dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { stubClerkSession } from "@/test/clerk";
import { readsOf, sentDashboardReads, sentDashboardRequests } from "@/test/dashboard-fetch";
import { SANDBOX_PROJECT } from "@/test/projects";
import { useBatchSendWizard } from "./use-batch-send-wizard";

beforeEach(() => {
  stubClerkSession({ isLoaded: false, orgId: null, userId: null });
});
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const BATCH_PATH = "/api/dashboard/payments/transfers/batch";
const ESTIMATE_PATH = `${BATCH_PATH}/estimate`;
const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const WALLETS_URL = dashboardRequestUrl(
  sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: true })
);
const RECIPIENTS_URL = dashboardRequestUrl(
  paymentsQueryKeys.projectCounterpartyAccounts(SCOPE, { page: 1, pageSize: 6, search: "" })
);

const wallets: PaymentsDashboardWallet[] = [
  {
    id: "wallet-usdc",
    walletId: "provider-usdc",
    isRuntimeExecutionAllowed: true,
    custodyConfigId: "cc_test",
    publicKey: "usdc-wallet",
    label: "USDC Treasury",
    balances: [{ token: "USDC", mint: MINT, amount: "50000000", uiAmount: "50", decimals: 6 }],
  },
];

const alice: CounterpartyAccountSummary = {
  counterpartyId: "cp_alice",
  counterpartyAccountId: "acct_alice",
  name: "Alice",
  address: "11111111111111111111111111111111",
  label: null,
};

/** What the batch POST answers next: a lost answer, a refusal, or the recorded batch. */
let nextSend: () => Promise<Response>;
let nextEstimate: () => Response;
const fetchMock = vi.fn<typeof fetch>();

const recordedBatch = () =>
  Response.json({
    data: {
      batch: { id: "batch_1", status: "confirmed", recipientCount: 1, transactionCount: 1 },
      recipients: [],
      transfers: [],
    },
  });

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("admin")}
        flags={{
          assetProfiles: false,
          compliance: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          privateChannels: false,
          releaseChannel: "experimental",
          ramps: true,
        }}
        serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
        projects={[]}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderWizard() {
  return renderHook(
    () =>
      useBatchSendWizard({
        issuedTokenSymbolsByMint: {},
        cluster: "devnet",
        onExit: vi.fn(),
      }),
    { wrapper }
  );
}

type Wizard = ReturnType<typeof renderWizard>["result"];

/** Fills one recipient with a blank Reference and opens the review, ready to send. */
async function openReview(result: Wizard) {
  await waitFor(() => expect(result.current.liveWallets).toHaveLength(1));
  act(() => result.current.selectWallet("wallet-usdc"));
  act(() => result.current.setRecipientAmount(alice, "1.5"));
  await act(async () => result.current.handlePrimary());
  expect(result.current.currentStepId).toBe("REVIEW");
  await waitFor(() => expect(result.current.estimate).not.toBeNull());
  expect(result.current.canProceed).toBe(true);
}

const sentBatchSchema = z.looseObject({ externalId: z.string().optional() });

function batchSends() {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === BATCH_PATH && init?.method === "POST")
    .map(([, init]) => ({
      key: new Headers(init?.headers).get("Idempotency-Key"),
      body: sentBatchSchema.parse(JSON.parse(String(init?.body))),
    }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetTransferBatchIdempotencyStateForTests();
  nextSend = async () => recordedBatch();
  nextEstimate = () =>
    Response.json({
      data: {
        estimate: {
          recipientCount: 1,
          transactionCount: 1,
          estimatedFees: {
            networkFeeLamports: "5000",
            priorityFeeLamports: "0",
            tokenAccountRentLamports: "0",
            sponsored: false,
          },
          warnings: [],
        },
      },
    });
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === WALLETS_URL) {
      return Response.json({ data: { wallets } });
    }
    if (url === RECIPIENTS_URL) {
      return Response.json({ data: { accounts: [alice], total: 1, page: 1, pageSize: 6 } });
    }
    if (url === ESTIMATE_PATH) {
      return nextEstimate();
    }
    if (url === BATCH_PATH && init?.method === "POST") {
      return nextSend();
    }
    if (url === `${BATCH_PATH}/batch_1/retry` && init?.method === "POST") {
      return recordedBatch();
    }
    return Response.json({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useBatchSendWizard after a send it could not confirm", () => {
  it("locks the review after a lost answer and retries the identical request", async () => {
    const { result } = renderWizard();
    await openReview(result);

    nextSend = () => Promise.reject(new TypeError("Failed to fetch"));
    await act(async () => result.current.handlePrimary());
    expect(result.current.recovering).toBe(true);
    expect(result.current.batchResult).toBeNull();
    expect(result.current.canProceed).toBe(true);

    // Back does nothing, and a change to the draft never reaches the retry.
    act(() => result.current.handleBack());
    expect(result.current.currentStepId).toBe("REVIEW");
    act(() => result.current.setRecipientAmount(alice, "9"));

    nextSend = async () => recordedBatch();
    await act(async () => result.current.handlePrimary());
    expect(result.current.recovering).toBe(false);
    expect(result.current.batchResult?.batch.id).toBe("batch_1");

    const [lost, retry] = batchSends();
    expect(lost.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.key).toBe(lost.key);
    expect(lost.body.externalId).toMatch(/^batch-/);
    expect(retry.body).toEqual(lost.body);
  });

  it.each([
    ["a 5xx", () => Response.json({ error: { message: "boom" } }, { status: 503 })],
    [
      "a key still in flight",
      () =>
        Response.json(
          { error: { code: "IDEMPOTENCY_KEY_IN_FLIGHT", message: "in flight" } },
          { status: 409 }
        ),
    ],
  ])("locks the review after %s", async (_label, answer) => {
    const { result } = renderWizard();
    await openReview(result);

    nextSend = async () => answer();
    await act(async () => result.current.handlePrimary());
    expect(result.current.recovering).toBe(true);
    act(() => result.current.handleBack());
    expect(result.current.currentStepId).toBe("REVIEW");
  });

  it("stays editable after a refusal that wrote nothing", async () => {
    const { result } = renderWizard();
    await openReview(result);

    nextSend = async () =>
      Response.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid recipient" } },
        { status: 400 }
      );
    await act(async () => result.current.handlePrimary());
    expect(result.current.recovering).toBe(false);

    act(() => result.current.handleBack());
    expect(result.current.currentStepId).toBe("RECIPIENTS");
  });
});

describe("useBatchSendWizard estimate", () => {
  it("posts exactly the review's batch under the tab's Project", async () => {
    const { result } = renderWizard();
    await openReview(result);

    expect(
      sentDashboardRequests(fetchMock).filter((request) => request.path === ESTIMATE_PATH)
    ).toEqual([
      {
        path: ESTIMATE_PATH,
        method: "POST",
        idempotencyKey: null,
        body: {
          sourceCustodyWalletId: "wallet-usdc",
          token: MINT,
          recipients: [
            { counterpartyId: "cp_alice", counterpartyAccountId: "acct_alice", amount: "1.5" },
          ],
        },
      },
    ]);
    expect(sentDashboardReads(fetchMock).filter((read) => read.path === ESTIMATE_PATH)).toEqual([
      { path: ESTIMATE_PATH, projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });

  it("words a failed estimate in its own copy, whatever the API said", async () => {
    nextEstimate = () => Response.json({ error: { message: "upstream detail" } }, { status: 503 });
    const { result } = renderWizard();
    await waitFor(() => expect(result.current.liveWallets).toHaveLength(1));
    act(() => result.current.selectWallet("wallet-usdc"));
    act(() => result.current.setRecipientAmount(alice, "1.5"));
    await act(async () => result.current.handlePrimary());

    await waitFor(() => expect(result.current.estimateError).toBe("Estimate failed."));
  });
});

describe("useBatchSendWizard after money moves", () => {
  it("reads the wallets again after a send and after a retry, and leaves the recipients alone", async () => {
    nextSend = async () =>
      Response.json({
        data: {
          batch: {
            id: "batch_1",
            status: "partially_failed",
            recipientCount: 1,
            transactionCount: 1,
          },
          recipients: [{ id: "rcpt_alice", status: "failed" }],
          transfers: [],
        },
      });
    const { result } = renderWizard();
    await openReview(result);
    const walletReads = readsOf(fetchMock, WALLETS_URL);
    const recipientReads = readsOf(fetchMock, RECIPIENTS_URL);

    await act(async () => result.current.handlePrimary());
    await waitFor(() => expect(readsOf(fetchMock, WALLETS_URL)).toBe(walletReads + 1));
    expect(result.current.failedRecipientCount).toBe(1);
    await act(async () => result.current.retryFailedRecipients());
    await waitFor(() => expect(readsOf(fetchMock, WALLETS_URL)).toBe(walletReads + 2));

    expect(readsOf(fetchMock, RECIPIENTS_URL)).toBe(recipientReads);
  });
});
