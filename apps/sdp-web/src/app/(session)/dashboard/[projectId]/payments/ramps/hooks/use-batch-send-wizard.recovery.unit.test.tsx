// @vitest-environment jsdom

import type { CounterpartyAccountSummary, PaymentsDashboardWallet } from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetTransferBatchIdempotencyStateForTests } from "@/app/(session)/dashboard/[projectId]/payments/transfer-batch-idempotency";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { stubClerkSession } from "@/test/clerk";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { useBatchSendWizard } from "./use-batch-send-wizard";

beforeEach(() => {
  stubClerkSession({ isLoaded: false, orgId: null, userId: null });
});
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const BATCH_PATH = "/api/dashboard/payments/transfers/batch";

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
          sandboxOnBeta: false,
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
        wallets,
        walletsError: null,
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
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/dashboard/wallets?view=summary&includeBalances=true") {
      return Response.json({ data: { wallets } });
    }
    if (url.startsWith("/api/dashboard/counterparty/accounts?")) {
      return Response.json({ data: { accounts: [alice], total: 1, page: 1, pageSize: 6 } });
    }
    if (url === `${BATCH_PATH}/estimate`) {
      return Response.json({
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
    }
    if (url === BATCH_PATH && init?.method === "POST") {
      return nextSend();
    }
    return Response.json({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
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

describe("useBatchSendWizard request", () => {
  it("estimates and sends the batch for the URL's Project", async () => {
    setDashboardUrl("/dashboard/prj_batch_url/payments", {});
    const { result } = renderWizard();
    await openReview(result);
    await act(async () => result.current.handlePrimary());

    const posts = fetchMock.mock.calls
      .filter(([input, init]) => String(input).startsWith(BATCH_PATH) && init?.method === "POST")
      .map(([input, init]) => ({
        path: String(input),
        projectId: z.looseObject({ projectId: z.string() }).parse(JSON.parse(String(init?.body)))
          .projectId,
      }));
    expect(posts).toContainEqual({ path: `${BATCH_PATH}/estimate`, projectId: "prj_batch_url" });
    expect(posts).toContainEqual({ path: BATCH_PATH, projectId: "prj_batch_url" });
  });
});
