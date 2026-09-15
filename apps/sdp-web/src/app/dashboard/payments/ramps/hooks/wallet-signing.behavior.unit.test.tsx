// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useBatchSendWizard } from "./use-batch-send-wizard";
import { useOfframpWizard } from "./use-offramp-wizard";
import { useOnchainReceiveWizard } from "./use-onchain-receive-wizard";
import { useOnchainSendWizard } from "./use-onchain-send-wizard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
  }),
}));

const MINT = "So11111111111111111111111111111111111111112";
const wallet: PaymentsDashboardWallet = {
  id: "cwlt_selected",
  walletId: "privy_shared",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "SOL", mint: MINT, amount: "10000000000", uiAmount: "10", decimals: 9 }],
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

describe("wallet selection during payments", () => {
  it("blocks offramp funding after runtime disablement while preserving its quote", async () => {
    const source = {
      ...wallet,
      balances: [{ token: "USDC", mint: MINT, amount: "10000000", uiAmount: "10", decimals: 6 }],
    };
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/wallets?")) return Response.json({ data: { wallets: [source] } });
      if (url.includes("/requirements"))
        return Response.json({ data: { provider: "bvnk", direction: "offramp", status: "ready" } });
      if (url.endsWith("/quote"))
        return Response.json({
          data: {
            transferId: "transfer_ramp",
            quote: {
              id: "quote_ramp",
              provider: "bvnk",
              status: "pending",
              deliveryMode: "manual_instructions",
              paymentInstructions: [
                { kind: "crypto_deposit", destinationAddress: wallet.publicKey },
              ],
            },
          },
        });
      if (url.includes("/transfers/"))
        return Response.json({
          data: { transfer: { id: "transfer_ramp", status: "awaiting_payment" } },
        });
      if (init?.method === "POST") sent.push(JSON.parse(String(init.body)));
      return Response.json({ data: { counterparties: [], total: 0 } });
    });
    const { result } = renderHook(
      () => ({
        wizard: useOfframpWizard({
          wallets: [source],
          walletsError: null,
          enabledRampProviders: ["bvnk"],
          rampProviderAccess: null,
          counterpartiesResult: { ok: true, data: [] },
          selectedCounterparty: null,
          initialCounterpartyId: "cpty_receiver",
          onExit: vi.fn(),
        }),
        mutate: useSWRConfig().mutate,
      }),
      { wrapper }
    );
    act(() => {
      result.current.wizard.setField("walletId", source.id);
      result.current.wizard.setField("amount", "1");
      result.current.wizard.selectProvider("bvnk");
    });
    await act(() => result.current.wizard.handlePrimary());
    await waitFor(() => expect(result.current.wizard.canProceed).toBe(true));
    await act(() => result.current.wizard.handlePrimary());
    await act(() => result.current.wizard.handlePrimary());
    await waitFor(() => expect(result.current.wizard.canSendOnchain).toBe(true));

    await act(() =>
      result.current.mutate(
        paymentsQueryKeys.actionWallets(),
        [{ ...source, isRuntimeExecutionAllowed: false }],
        false
      )
    );
    expect(result.current.wizard.quote?.id).toBe("quote_ramp");
    expect(result.current.wizard.canSendOnchain).toBe(false);
    expect(result.current.wizard.liveWalletsError).toBeNull();
    expect(result.current.wizard.sourceWalletHint).toBe("Signing is disabled for this wallet.");
    await act(() => result.current.wizard.sendCryptoToDeposit());
    expect(sent).toEqual([]);
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
        return Response.json({ data: { accounts: [recipient], total: 1 } });
      if (String(input).endsWith("/estimate")) return Response.json({ data: { estimate: {} } });
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { message: "Unexpected submission" } }, { status: 400 });
    });
    const { result } = renderHook(
      () => ({
        wizard: useBatchSendWizard({
          wallets: [wallet],
          walletsError: null,
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
        paymentsQueryKeys.actionWallets(),
        [
          { ...wallet, isRuntimeExecutionAllowed: false },
          { ...wallet, id: "cwlt_other" },
        ],
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
                  accountKind: "crypto_wallet",
                  status: "active",
                  details: { address: "11111111111111111111111111111111" },
                },
              ],
            },
          });
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ data: { transfer: { id: "transfer", status: "completed" } } });
      });
      const { result } = renderHook(
        () => ({
          wizard: useOnchainSendWizard({
            wallets: [wallet],
            walletsError: null,
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
          paymentsQueryKeys.actionWallets(),
          change === "removed" ? [other] : [{ ...wallet, isRuntimeExecutionAllowed: false }, other],
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
        result.current.mutate(paymentsQueryKeys.actionWallets(), [other, wallet], false)
      );
      expect(sent).toEqual([]);
      await act(() => result.current.wizard.handlePrimary());
      expect(sent).toEqual([expect.objectContaining({ sourceCustodyWalletId: wallet.id })]);
    }
  );

  it("keeps receiving available when signing is disabled", async () => {
    const receivingWallet = { ...wallet, isRuntimeExecutionAllowed: false };
    vi.stubGlobal("fetch", async () => Response.json({ data: { wallets: [receivingWallet] } }));
    const { result } = renderHook(
      () =>
        useOnchainReceiveWizard({
          wallets: [receivingWallet],
          walletsError: null,
          counterpartyId: "cpty_sender",
          onExit: vi.fn(),
        }),
      { wrapper }
    );
    act(() => result.current.setWalletId(receivingWallet.id));
    expect(result.current.canProceed).toBe(true);
    act(() => result.current.handlePrimary());
    expect(result.current.currentStepId).toBe("RECEIVE");
    expect(result.current.selectedWallet?.id).toBe(receivingWallet.id);
  });
});
