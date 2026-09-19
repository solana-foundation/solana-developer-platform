// @vitest-environment jsdom

import type {
  BvnkRampSettlement,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import type { RenderHookResult } from "@testing-library/react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { useOnrampWizard } from "./use-onramp-wizard";
import type { UseRampWizardProps } from "./use-ramp-wizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: {
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    info: mocks.toastInfo,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRANSFER_ID = "xfr_bvnk_wizard";

const WALLET: PaymentsDashboardWallet = {
  id: "wallet-bvnk",
  walletId: "provider-bvnk",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "wallet-pubkey",
  label: "USDC Treasury",
  balances: [{ token: "USDC", mint: USDC_MINT, amount: "1000000", uiAmount: "1", decimals: 6 }],
};

// A bvnk onramp requirements answer that needs no collection and no onboarding:
// the advance straight to `ready` lets the transaction stage fire the quote.
const REQUIREMENTS_READY = { provider: "bvnk", direction: "onramp", status: "ready" };

const BVNK_QUOTE = {
  id: "quote_bvnk",
  provider: "bvnk",
  status: "pending",
  deliveryMode: "manual_instructions",
  paymentInstructions: [],
};

const BVNK_PROCESSING_SETTLEMENT: BvnkRampSettlement = {
  provider: "bvnk",
  status: "PROCESSING",
  payinId: "01a0ab3c-2c02-7788-ab94-d5ce3bbb5db9",
  payoutId: "01a0ab3c-4388-7e84-a501-3b02668d715b",
  receiptUrl: "https://pay.sandbox.bvnk.com/payout/01a0ab3c-4388-7e84-a501-3b02668d715b",
  fiatCurrency: "USD",
  fiatAmount: "9.9",
  cryptoCurrency: "USDC",
  cryptoAmount: "9.8802",
  feeCurrency: "USD",
  feeAmount: "0.1",
  networkFeeCurrency: "USD",
  networkFeeAmount: "0.12",
  exchangeRate: "0.998",
};

function transferFixture(
  status: PaymentTransferSummary["status"],
  overrides: Partial<PaymentTransferSummary> = {}
): PaymentTransferSummary {
  return {
    id: TRANSFER_ID,
    custodyWalletId: WALLET.id,
    providerWalletId: WALLET.walletId,
    status,
    signature: null,
    rampsMemo: {},
    type: "onramp",
    provider: "bvnk",
    ...overrides,
  };
}

const PROPS: UseRampWizardProps = {
  wallets: [WALLET],
  walletsError: null,
  enabledRampProviders: ["bvnk"],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
  selectedCounterparty: null,
  initialCounterpartyId: "counterparty-test",
  onExit: vi.fn(),
};

let currentTransfer: PaymentTransferSummary = transferFixture("awaiting_payment");
const fetchMock = vi.fn<typeof fetch>();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
        projects={[]}
        initialSelectedProjectId={null}
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function transferStatusCalls(): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).startsWith(`/api/dashboard/payments/transfers/${TRANSFER_ID}`)
  ).length;
}

beforeEach(() => {
  currentTransfer = transferFixture("awaiting_payment");
  fetchMock.mockReset().mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/dashboard/wallets")) {
      return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
    }
    if (url.startsWith("/api/dashboard/counterparty?page=")) {
      return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
    }
    if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
      return Promise.resolve(Response.json({ data: REQUIREMENTS_READY }));
    }
    if (url === "/api/dashboard/payments/ramps/onramp/quote" && method === "POST") {
      return Promise.resolve(
        Response.json({ data: { quote: BVNK_QUOTE, transferId: TRANSFER_ID } })
      );
    }
    if (url.startsWith(`/api/dashboard/payments/transfers/${TRANSFER_ID}`)) {
      return Promise.resolve(Response.json({ data: { transfer: currentTransfer } }));
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

type WizardRender = RenderHookResult<ReturnType<typeof useOnrampWizard>, unknown>;

/**
 * Drives the real wizard from the deposit step to the transaction stage: pick
 * the BVNK provider, fund the deposit form, advance through the memo (which
 * POSTs the requirements advance and lands on the PROVIDER step), let the
 * readiness effect fire the quote POST, and wait for the transfer-status poll
 * to deliver the scenario transfer.
 */
async function driveToTransferStatus(rendered: WizardRender) {
  await act(async () => {});
  act(() => rendered.result.current.selectProvider("bvnk"));
  act(() => rendered.result.current.setField("amount", "100"));
  act(() => rendered.result.current.setField("walletId", WALLET.id));
  await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
  await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));
  await waitFor(() => expect(rendered.result.current.transferStatus).toBeDefined());
}

/** Allows one 3s transfer-status polling tick to fire (or stay dead). */
async function allowPollingTick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3300));
  });
}

describe("useOnrampWizard — showCompleteScreen and transfer-status polling", () => {
  async function renderAtTransfer(transfer: PaymentTransferSummary): Promise<WizardRender> {
    currentTransfer = transfer;
    const rendered = renderHook(() => useOnrampWizard(PROPS), { wrapper });
    await driveToTransferStatus(rendered);
    return rendered;
  }

  it("awaits funding with the complete screen hidden and the status poll alive", async () => {
    const { result } = await renderAtTransfer(
      transferFixture("awaiting_payment", { providerReference: undefined })
    );

    expect(result.current.transferStatus?.status).toBe("awaiting_payment");
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    expect(callsBefore).toBeGreaterThanOrEqual(1);
    await allowPollingTick();
    expect(transferStatusCalls()).toBeGreaterThan(callsBefore);
  });

  it("keeps the complete screen hidden while settling without a settlement", async () => {
    const { result } = await renderAtTransfer(transferFixture("settling"));

    expect(result.current.transferStatus?.status).toBe("settling");
    expect(result.current.transferStatus?.settlement).toBeUndefined();
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBeGreaterThan(callsBefore);
  });

  it("shows the complete screen once a BVNK PROCESSING settlement arrives, polling until terminal", async () => {
    const { result } = await renderAtTransfer(
      transferFixture("settling", {
        providerReference: "01a0ab3c-4388-7e84-a501-3b02668d715b",
        settlement: BVNK_PROCESSING_SETTLEMENT,
      })
    );

    expect(result.current.transferStatus?.status).toBe("settling");
    expect(result.current.transferStatus?.settlement?.provider).toBe("bvnk");
    expect(result.current.showCompleteScreen).toBe(true);

    // PROCESSING is still non-terminal: the status poll keeps ticking.
    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBeGreaterThan(callsBefore);
  });

  it("keeps the complete screen for a completed transfer and stops polling", async () => {
    const signature =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const completeSettlement: BvnkRampSettlement = {
      ...BVNK_PROCESSING_SETTLEMENT,
      status: "COMPLETE",
      txHash: signature,
      cryptoAmountActual: "9.8802",
      fiatAmountActual: "9.9",
      feeAmountActual: "0.1",
      feeCurrencyActual: "USD",
      networkFeeAmountActual: "0",
      networkFeeCurrencyActual: "USD",
      exchangeRateActual: "0.998",
    };
    const { result } = await renderAtTransfer(
      transferFixture("completed", {
        signature,
        providerReference: "01a0ab3c-4388-7e84-a501-3b02668d715b",
        settlement: completeSettlement,
      })
    );

    expect(result.current.transferStatus?.status).toBe("completed");
    expect(result.current.showCompleteScreen).toBe(true);

    // Terminal statuses stop the poll: no refetch after a full interval.
    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBe(callsBefore);
  });

  it("turns the complete screen off for a failed transfer and stops polling", async () => {
    const { result } = await renderAtTransfer(transferFixture("failed"));

    expect(result.current.transferStatus?.status).toBe("failed");
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBe(callsBefore);
  });
});
