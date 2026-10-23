// @vitest-environment jsdom

import type { CounterpartyAccount } from "@sdp/types/counterparties";
import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTransferIdempotencyStateForTests } from "@/app/dashboard/[projectId]/payments/transfer-idempotency";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { useOnchainSendWizard } from "./use-onchain-send-wizard";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastSuccess: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));

const DESTINATION = "11111111111111111111111111111111";
const SECOND_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const cryptoAccount: CounterpartyAccount = {
  id: "account-crypto",
  organizationId: "org-test",
  projectId: "project-test",
  counterpartyId: "counterparty-test",
  accountKind: "crypto_wallet",
  label: "Destination",
  details: { address: DESTINATION },
  providerAccountData: {},
  status: "active",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const wallets: PaymentsDashboardWallet[] = [
  {
    id: "wallet-sol",
    walletId: "provider-sol",
    isRuntimeExecutionAllowed: true,
    custodyConfigId: "cc_test",
    publicKey: "sol-wallet",
    label: "SOL Treasury",
    balances: [
      {
        token: "SOL",
        mint: SOL_MINT,
        amount: "1250000000",
        tokenAmount: "1.25",
        displayAmount: "1.25",
        displayAsOf: null,
        displayRule: "plain",
        decimals: 9,
      },
    ],
  },
  {
    id: "wallet-usdc",
    walletId: "provider-usdc",
    isRuntimeExecutionAllowed: true,
    custodyConfigId: "cc_test",
    publicKey: "usdc-wallet",
    label: "USDC Treasury",
    balances: [
      {
        token: "USDC",
        mint: SECOND_MINT,
        amount: "750000",
        tokenAmount: "0.75",
        displayAmount: "0.75",
        displayAsOf: null,
        displayRule: "plain",
        decimals: 6,
      },
    ],
  },
];

const transfer: PaymentTransferSummary = {
  id: "transfer-test",
  custodyWalletId: "wallet-usdc",
  providerWalletId: "provider-usdc",
  status: "pending",
  signature: null,
  rampsMemo: {},
};

let accountsResponse: (() => void) | null = null;
let transferStatus = 200;
const fetchMock = vi.fn<typeof fetch>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("org:admin")}
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
  const onExit = vi.fn();
  return {
    onExit,
    ...renderHook(
      () =>
        useOnchainSendWizard({
          wallets,
          walletsError: null,
          issuedTokenSymbolsByMint: {},
          counterpartyId: "counterparty-test",
          onExit,
        }),
      { wrapper }
    ),
  };
}

async function resolveAccounts() {
  await waitFor(() => expect(accountsResponse).not.toBeNull());
  await act(async () => accountsResponse?.());
}

async function prepareReview(result: ReturnType<typeof renderWizard>["result"]) {
  await resolveAccounts();
  act(() => result.current.setField("accountId", cryptoAccount.id));
  await act(async () => result.current.handlePrimary());
  act(() => result.current.selectWallet("wallet-usdc"));
  act(() => result.current.setField("amount", "0.5"));
  await act(async () => result.current.handlePrimary());
}

/** A scaled mint's terms and a debit quote for SECOND_MINT: 1 shown is 0.5 token units. */
function stubScaledMint(expiresAt: string) {
  const base = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url === `/api/dashboard/tokens/${SECOND_MINT}/terms`) {
      return Promise.resolve(
        Response.json({
          data: {
            terms: {
              mint: SECOND_MINT,
              decimals: 6,
              transferFee: null,
              display: {
                rule: "scaled",
                multiplier: 2,
                newMultiplier: 2,
                newMultiplierEffectiveAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        })
      );
    }
    if (url === `/api/dashboard/tokens/${SECOND_MINT}/quote`) {
      return Promise.resolve(
        Response.json({
          data: {
            quote: {
              mint: SECOND_MINT,
              amount: "0.5",
              amounts: { basis: "debit", debit: "0.5", fee: "0", credit: "0.5", decimals: 6 },
              feeEpoch: null,
              asOf: "2026-10-22T12:00:00.000Z",
              expiresAt,
            },
          },
        })
      );
    }
    if (base === undefined) throw new Error("fetch mock has no implementation");
    return base(input, init);
  });
}

function quotePosts() {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/quote"));
}

function transferPosts() {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === "/api/dashboard/payments/transfers" && init?.method === "POST"
  );
}

function sentIdempotencyKeys() {
  return transferPosts().map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferIdempotencyStateForTests();
  accountsResponse = null;
  transferStatus = 200;
  fetchMock.mockReset().mockImplementation((input, init) => {
    const url = String(input);
    if (url === "/api/dashboard/wallets?view=summary&includeBalances=true") {
      return Promise.resolve(Response.json({ data: { wallets } }));
    }
    if (url === "/api/dashboard/counterparty/counterparty-test/accounts?pageSize=100") {
      return new Promise<Response>((resolve) => {
        accountsResponse = () =>
          resolve(
            Response.json({
              data: {
                accounts: [
                  cryptoAccount,
                  {
                    ...cryptoAccount,
                    id: "account-bank",
                    accountKind: "bank_account",
                    details: { accountNumberLast4: "1234" },
                  },
                ],
              },
            })
          );
      });
    }
    if (url === "/api/dashboard/payments/transfers" && init?.method === "POST") {
      if (transferStatus === 200) {
        return Promise.resolve(Response.json({ data: { transfer } }));
      }
      return Promise.resolve(
        Response.json({ error: { message: "transfer rejected" } }, { status: transferStatus })
      );
    }
    return Promise.resolve(Response.json({ data: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useOnchainSendWizard", () => {
  it("loads active crypto destinations and navigates destination steps", async () => {
    const { result, onExit } = renderWizard();

    expect(result.current.currentStepId).toBe("DESTINATION");
    expect(result.current.canProceed).toBe(false);
    expect(result.current.accountsLoading).toBe(true);

    await resolveAccounts();
    await waitFor(() => expect(result.current.accountsLoading).toBe(false));
    expect(result.current.cryptoAccounts).toEqual([cryptoAccount]);

    act(() => result.current.setField("accountId", cryptoAccount.id));
    expect(result.current.destinationAddress).toBe(DESTINATION);
    expect(result.current.canProceed).toBe(true);

    await act(async () => result.current.handlePrimary());
    expect(result.current.currentStepId).toBe("DETAILS");
    act(() => result.current.handleSecondary());
    expect(result.current.currentStepId).toBe("DESTINATION");
    act(() => result.current.handleSecondary());
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("selects wallet assets, checks balances, and builds review submissions", async () => {
    const { result } = renderWizard();
    await resolveAccounts();
    act(() => result.current.setField("accountId", cryptoAccount.id));
    await act(async () => result.current.handlePrimary());

    act(() => result.current.selectWallet("wallet-sol"));
    expect(result.current.fields.walletId).toBe("wallet-sol");
    expect(result.current.fields.asset).toBe(SOL_MINT);
    act(() => result.current.selectWallet("wallet-usdc"));
    expect(result.current.fields.asset).toBe(SECOND_MINT);
    expect(result.current.availableAmount).toBe("0.75");

    act(() => result.current.setField("amount", "999"));
    expect(result.current.exceedsBalance).toBe(true);
    act(() => result.current.setField("amount", "0.5"));
    expect(result.current.exceedsBalance).toBe(false);
    await act(async () => result.current.handlePrimary());
    expect(result.current.currentStepId).toBe("REVIEW");
    expect(result.current.readySubmission).toEqual({
      sourceCustodyWalletId: "wallet-usdc",
      destination: DESTINATION,
      token: SECOND_MINT,
      amount: "0.5",
    });

    act(() => result.current.setField("memo", "invoice-42"));
    expect(result.current.readySubmission).toEqual({
      sourceCustodyWalletId: "wallet-usdc",
      destination: DESTINATION,
      token: SECOND_MINT,
      amount: "0.5",
      memo: "invoice-42",
    });
  });

  it.each([
    { name: "stores a successful transfer", status: 200, succeeds: true },
    { name: "reports a rejected transfer", status: 422, succeeds: false },
  ])("$name", async ({ status, succeeds }) => {
    transferStatus = status;
    const { result } = renderWizard();
    await prepareReview(result);

    await act(async () => result.current.handlePrimary());

    expect(result.current.submitting).toBe(false);
    expect(result.current.transferResult).toEqual(succeeds ? transfer : null);
    const transferCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/dashboard/payments/transfers"
    );
    expect(JSON.parse(String(transferCall?.[1]?.body))).toEqual({
      sourceCustodyWalletId: "wallet-usdc",
      destination: DESTINATION,
      token: SECOND_MINT,
      amount: "0.5",
    });
    expect(mocks.toastError).toHaveBeenCalledTimes(succeeds ? 0 : 1);
  });

  // A refusal retires a fresh key; after a lost answer it settles nothing about
  // the attempt that may have written, so the key stays (HOO-1918).
  it("retires a fresh key on a refusal, and keeps a lost answer's key through one", async () => {
    transferStatus = 422;
    const { result } = renderWizard();
    await prepareReview(result);

    await act(async () => result.current.handlePrimary());
    transferStatus = 503;
    await act(async () => result.current.handlePrimary());
    transferStatus = 422;
    await act(async () => result.current.handlePrimary());

    const [refused, lost, afterRefusal] = sentIdempotencyKeys();
    expect(lost).not.toBe(refused);
    expect(afterRefusal).toBe(lost);
    expect(mocks.toastError).toHaveBeenCalledTimes(3);
  });

  it("selects a newly added account and closes the dialog", async () => {
    const { result } = renderWizard();
    await resolveAccounts();
    act(() => result.current.setAddAccountOpen(true));
    act(() => result.current.handleAccountAdded(cryptoAccount));

    expect(result.current.fields.accountId).toBe(cryptoAccount.id);
    expect(result.current.addAccountOpen).toBe(false);
  });
  it("sends the token amount a display amount is priced at, never the display amount", async () => {
    stubScaledMint("2099-01-01T00:00:00.000Z");
    const { result } = renderWizard();
    await resolveAccounts();
    act(() => result.current.setField("accountId", cryptoAccount.id));
    await act(async () => result.current.handlePrimary());
    act(() => result.current.selectWallet("wallet-usdc"));
    await waitFor(() => expect(result.current.amountEntry.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.amountEntry.setUnit("display");
      result.current.setField("displayAmount", "1");
    });
    // Continue and Back wait for the quote.
    expect(result.current.quoteInFlight).toBe(true);
    expect(result.current.canProceed).toBe(false);

    await waitFor(() => expect(result.current.sendAmount).toBe("0.5"));
    expect(JSON.parse(String(quotePosts()[0]?.[1]?.body))).toEqual({
      displayAmount: "1",
      basis: "debit",
    });
    await act(async () => result.current.handlePrimary());
    expect(result.current.currentStepId).toBe("REVIEW");
    await act(async () => result.current.handlePrimary());

    expect(JSON.parse(String(transferPosts()[0]?.[1]?.body))).toEqual({
      sourceCustodyWalletId: "wallet-usdc",
      destination: DESTINATION,
      token: SECOND_MINT,
      amount: "0.5",
    });
  });

  it("refuses to send a display amount whose quote has expired", async () => {
    stubScaledMint("2000-01-01T00:00:00.000Z");
    const { result } = renderWizard();
    await resolveAccounts();
    act(() => result.current.setField("accountId", cryptoAccount.id));
    await act(async () => result.current.handlePrimary());
    act(() => result.current.selectWallet("wallet-usdc"));
    await waitFor(() => expect(result.current.amountEntry.displayEntryAvailable).toBe(true));
    act(() => {
      result.current.amountEntry.setUnit("display");
      result.current.setField("displayAmount", "1");
    });
    await waitFor(() => expect(result.current.canProceed).toBe(true));
    await act(async () => result.current.handlePrimary());
    await waitFor(() => expect(result.current.canProceed).toBe(true));
    await act(async () => result.current.handlePrimary());

    expect(transferPosts()).toHaveLength(0);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The price of this amount expired, so it was priced again. Check the amount and try again.",
      expect.anything()
    );
  });
});
