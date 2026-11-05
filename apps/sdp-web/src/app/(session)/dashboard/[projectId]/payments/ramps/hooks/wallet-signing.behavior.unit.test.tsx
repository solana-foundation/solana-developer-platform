// @vitest-environment jsdom

import type {
  PaymentsDashboardWallet,
  PaymentTransferBatchEstimateWarning,
} from "@sdp/types/payments";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { type DashboardKeyScope, dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { readsOf, sentDashboardRequests } from "@/test/dashboard-fetch";
import { SANDBOX_PROJECT } from "@/test/projects";
import { useBatchSendWizard } from "./use-batch-send-wizard";
import { useOfframpWizard } from "./use-offramp-wizard";
import { useOnchainSendWizard } from "./use-onchain-send-wizard";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
  }),
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
  }),
}));

const MINT = "So11111111111111111111111111111111111111112";
/** The part of a posted batch estimate request the stubs read. */
const postedBatchSchema = z.object({ recipients: z.array(z.unknown()) });
const wallet: PaymentsDashboardWallet = {
  id: "cwlt_selected",
  walletId: "privy_shared",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  custodyConfigId: "cc_test",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "SOL", mint: MINT, amount: "10000000000", uiAmount: "10", decimals: 9 }],
};
const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const WALLETS_KEY = sharedReadQueryKeys.walletSummaries(SCOPE, { includeBalances: true });
const WALLETS_URL = dashboardRequestUrl(WALLETS_KEY);

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

const TRANSFERS_PATH = "/api/dashboard/payments/transfers";

function transferPosts(fetchMock: Mock<typeof fetch>) {
  return sentDashboardRequests(fetchMock).filter(
    (request) => request.path === TRANSFERS_PATH && request.method === "POST"
  );
}

/** An offramp driven to its funding step, quoted by a hosted provider with a deposit address. */
async function renderFundableOfframp() {
  const source = {
    ...wallet,
    balances: [{ token: "USDC", mint: MINT, amount: "10000000", uiAmount: "10", decimals: 6 }],
  };
  const rampTransfer = {
    id: "transfer_ramp",
    custodyWalletId: source.id,
    providerWalletId: source.walletId,
    status: "awaiting_payment",
    signature: null,
    rampsMemo: {},
    cryptoDeposit: { destinationAddress: wallet.publicKey, amount: "1" },
  };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/wallets?")) return Response.json({ data: { wallets: [source] } });
    if (url.includes("/requirements"))
      return Response.json({
        data: { provider: "moonpay", direction: "offramp", status: "ready" },
      });
    if (url.endsWith("/quote"))
      return Response.json({
        data: {
          transferId: "transfer_ramp",
          quote: {
            id: "quote_ramp",
            provider: "moonpay",
            status: "pending",
            deliveryMode: "hosted",
            hostedUrl: "https://sell-sandbox.moonpay.com/",
          },
        },
      });
    if (url.includes("/transfers/")) return Response.json({ data: { transfer: rampTransfer } });
    if (url === TRANSFERS_PATH && init?.method === "POST")
      return Response.json({ data: { transfer: { ...rampTransfer, status: "processing" } } });
    return Response.json({ error: { message: "Unexpected request" } }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(
    () => ({
      wizard: useOfframpWizard({
        enabledRampProviders: ["moonpay"],
        rampProviderAccess: null,
        counterparties: {
          result: { ok: true, data: [] },
          loading: false,
          retry: vi.fn(),
          addCreated: vi.fn(),
        },
        selectedCounterparty: null,
        initialCounterpartyId: "cpty_receiver",
        onExit: vi.fn(),
      }),
      mutate: useSWRConfig().mutate,
    }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.wizard.liveWallets).toHaveLength(1));
  act(() => {
    result.current.wizard.setField("walletId", source.id);
    result.current.wizard.setField("amount", "1");
    result.current.wizard.selectProvider("moonpay");
  });
  await act(() => result.current.wizard.handlePrimary());
  await waitFor(() => expect(result.current.wizard.canProceed).toBe(true));
  await act(() => result.current.wizard.handlePrimary());
  await act(() => result.current.wizard.handlePrimary());
  await waitFor(() => expect(result.current.wizard.canSendOnchain).toBe(true));
  return { result, source, fetchMock };
}

describe("wallet selection during payments", () => {
  it("blocks offramp funding after runtime disablement while preserving its quote", async () => {
    const { result, source, fetchMock } = await renderFundableOfframp();

    await act(() =>
      result.current.mutate(
        WALLETS_KEY,
        { data: { wallets: [{ ...source, isRuntimeExecutionAllowed: false }] } },
        false
      )
    );
    expect(result.current.wizard.quote?.id).toBe("quote_ramp");
    expect(result.current.wizard.canSendOnchain).toBe(false);
    expect(result.current.wizard.liveWalletsError).toBeNull();
    expect(result.current.wizard.sourceWalletHint).toBe("Signing is disabled for this wallet.");
    await act(() => result.current.wizard.sendCryptoToDeposit());
    expect(transferPosts(fetchMock)).toEqual([]);
  });

  it("funds the payout under its transfer id with no key of its own, then reads the wallets again", async () => {
    const { result, source, fetchMock } = await renderFundableOfframp();
    const walletReads = readsOf(fetchMock, WALLETS_URL);

    await act(() => result.current.wizard.sendCryptoToDeposit());

    expect(transferPosts(fetchMock)).toEqual([
      {
        path: TRANSFERS_PATH,
        method: "POST",
        idempotencyKey: null,
        body: {
          transferId: "transfer_ramp",
          sourceCustodyWalletId: source.id,
          destination: wallet.publicKey,
          token: MINT,
          amount: "1",
        },
      },
    ]);
    await waitFor(() => expect(readsOf(fetchMock, WALLETS_URL)).toBe(walletReads + 1));
  });

  it("stops a batch at review when its selected Connection loses signing admission", async () => {
    const recipient = {
      counterpartyId: "cpty_receiver",
      counterpartyAccountId: "cpa_receiver",
      name: "Receiver",
      address: wallet.publicKey,
      label: null,
    };
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [wallet] } });
      if (String(input).includes("/accounts?"))
        return Response.json({ data: { accounts: [recipient], total: 1, page: 1, pageSize: 6 } });
      if (String(input).endsWith("/estimate"))
        return Response.json({
          data: {
            estimate: {
              recipientCount: 1,
              transactionCount: 1,
              estimatedFees: {
                networkFeeLamports: "5000",
                priorityFeeLamports: "0",
                tokenAccountRentLamports: "0",
                sponsored: true,
              },
              warnings: [],
            },
          },
        });
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { message: "Unexpected submission" } }, { status: 400 });
    });
    const { result } = renderHook(
      () => ({
        wizard: useBatchSendWizard({
          issuedTokenSymbolsByMint: {},
          cluster: "devnet",
          onExit: vi.fn(),
        }),
        mutate: useSWRConfig().mutate,
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.wizard.pageRecipients).toHaveLength(1));
    act(() => {
      result.current.wizard.selectWallet(wallet.id);
      result.current.wizard.setRecipientAmount(recipient, "1");
    });
    await act(() => result.current.wizard.handlePrimary());
    expect(result.current.wizard.currentStepId).toBe("REVIEW");
    await act(() =>
      result.current.mutate(
        WALLETS_KEY,
        {
          data: {
            wallets: [
              { ...wallet, isRuntimeExecutionAllowed: false },
              { ...wallet, id: "cwlt_other" },
            ],
          },
        },
        false
      )
    );
    expect(result.current.wizard.walletId).toBe(wallet.id);
    expect(result.current.wizard.canProceed).toBe(false);
    expect(result.current.wizard.liveWalletsError).toBeNull();
    expect(result.current.wizard.sourceWalletHint).toBe("Signing is disabled for this wallet.");
    await act(() => result.current.wizard.handlePrimary());
    expect(sent).toEqual([]);
  });

  it("pairs each review with its own estimate after a flagged recipient is removed (HOO-2375)", async () => {
    const recipients = ["cpa_a", "cpa_b"].map((counterpartyAccountId) => ({
      counterpartyId: "cpty_receiver",
      counterpartyAccountId,
      name: counterpartyAccountId,
      address: wallet.publicKey,
      label: null,
    }));
    const estimate = (count: number, warnings: PaymentTransferBatchEstimateWarning[]) => ({
      data: {
        estimate: {
          recipientCount: count,
          transactionCount: 1,
          estimatedFees: {
            networkFeeLamports: "5000",
            priorityFeeLamports: "0",
            tokenAccountRentLamports: "0",
            sponsored: true,
          },
          warnings,
        },
      },
    });
    let releaseSecond: (() => void) | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [wallet] } });
      if (String(input).includes("/accounts?"))
        return Response.json({ data: { accounts: recipients, total: 2, page: 1, pageSize: 6 } });
      if (String(input).endsWith("/estimate")) {
        const body = postedBatchSchema.parse(JSON.parse(String(init?.body)));
        if (body.recipients.length === 2) {
          return Response.json(
            estimate(2, [
              {
                code: "AMOUNT_BELOW_RENT_MINIMUM",
                recipientIndex: 1,
                minimumAmount: "0.00089088",
                message: "below minimum",
              },
            ])
          );
        }
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        return Response.json(estimate(1, []));
      }
      return Response.json({ error: { message: "Unexpected request" } }, { status: 400 });
    });
    const { result } = renderHook(
      () =>
        useBatchSendWizard({
          issuedTokenSymbolsByMint: {},
          cluster: "devnet",
          onExit: vi.fn(),
        }),
      {
        // The dashboard's default, which an estimate must not inherit.
        wrapper: ({ children }: { children: ReactNode }) => (
          <I18nProvider locale="en" messages={getMessages("en")}>
            <SWRConfig
              value={{ provider: () => new Map(), dedupingInterval: 0, keepPreviousData: true }}
            >
              {children}
            </SWRConfig>
          </I18nProvider>
        ),
      }
    );
    await waitFor(() => expect(result.current.pageRecipients).toHaveLength(2));
    act(() => {
      result.current.selectWallet(wallet.id);
      for (const recipient of recipients) result.current.setRecipientAmount(recipient, "0.0001");
    });
    await act(() => result.current.handlePrimary());
    await waitFor(() => expect(result.current.belowRentMinimum.size).toBe(1));
    expect(result.current.canProceed).toBe(false);

    act(() => result.current.handleBack());
    act(() => result.current.toggleRecipient(recipients[1]));
    await act(() => result.current.handlePrimary());

    // The two-recipient estimate is not reused for the one-recipient request.
    expect(result.current.currentStepId).toBe("REVIEW");
    expect(result.current.belowRentMinimum.size).toBe(0);
    expect(result.current.canProceed).toBe(false);
    await waitFor(() => expect(releaseSecond).toBeDefined());
    act(() => releaseSecond?.());
    await waitFor(() => expect(result.current.canProceed).toBe(true));
  });

  it.each(["disabled", "removed"])(
    "does not replace a %s exact wallet at send review",
    async (change) => {
      const sent: unknown[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/wallets?"))
          return Response.json({ data: { wallets: [wallet] } });
        if (String(input).includes("/accounts?"))
          return Response.json({
            data: {
              accounts: [
                {
                  id: "cpa_receiver",
                  organizationId: "org_test",
                  projectId: SANDBOX_PROJECT.id,
                  counterpartyId: "cpty_receiver",
                  accountKind: "crypto_wallet",
                  label: null,
                  details: { address: "11111111111111111111111111111111" },
                  providerAccountData: {},
                  status: "active",
                  createdAt: "2026-10-20T00:00:00.000Z",
                  updatedAt: "2026-10-20T00:00:00.000Z",
                },
              ],
              total: 1,
              page: 1,
              pageSize: 100,
            },
          });
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ data: { transfer: { id: "transfer", status: "completed" } } });
      });
      const { result } = renderHook(
        () => ({
          wizard: useOnchainSendWizard({
            issuedTokenSymbolsByMint: {},
            counterpartyId: "cpty_receiver",
            onExit: vi.fn(),
          }),
          mutate: useSWRConfig().mutate,
        }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.wizard.cryptoAccounts).toHaveLength(1));
      expect(result.current.wizard.fields.walletId).toBe("");
      act(() => result.current.wizard.setField("accountId", "cpa_receiver"));
      await act(() => result.current.wizard.handlePrimary());
      act(() => {
        result.current.wizard.selectWallet(wallet.id);
        result.current.wizard.setField("amount", "1");
      });
      await act(() => result.current.wizard.handlePrimary());
      expect(result.current.wizard.currentStepId).toBe("REVIEW");

      const other = { ...wallet, id: "cwlt_other" };
      await act(() =>
        result.current.mutate(
          WALLETS_KEY,
          {
            data: {
              wallets:
                change === "removed"
                  ? [other]
                  : [{ ...wallet, isRuntimeExecutionAllowed: false }, other],
            },
          },
          false
        )
      );
      expect(result.current.wizard.fields.walletId).toBe(wallet.id);
      expect(result.current.wizard.canProceed).toBe(false);
      expect(result.current.wizard.liveWalletsError).toBeNull();
      // A wallet that vanished from the list cannot sign either, so the hint stays.
      expect(result.current.wizard.sourceWalletHint).toBe("Signing is disabled for this wallet.");
      await act(() => result.current.wizard.handlePrimary());
      expect(sent).toEqual([]);
      await act(() =>
        result.current.mutate(WALLETS_KEY, { data: { wallets: [other, wallet] } }, false)
      );
      expect(sent).toEqual([]);
      await act(() => result.current.wizard.handlePrimary());
      expect(sent).toEqual([expect.objectContaining({ sourceCustodyWalletId: wallet.id })]);
    }
  );
});
