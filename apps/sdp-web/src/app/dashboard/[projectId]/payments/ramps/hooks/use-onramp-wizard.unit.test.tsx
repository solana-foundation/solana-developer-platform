// @vitest-environment jsdom

import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import type { RenderHookResult } from "@testing-library/react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { useOnrampWizard } from "./use-onramp-wizard";
import type { UseRampWizardProps } from "./use-ramp-wizard";

const mocks = vi.hoisted(() => ({
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
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
const TRANSFER_ID = "xfr_moonpay_wizard";

const WALLET: PaymentsDashboardWallet = {
  id: "wallet-moonpay",
  walletId: "provider-moonpay",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "wallet-pubkey",
  label: "USDC Treasury",
  balances: [{ token: "USDC", mint: USDC_MINT, amount: "1000000", uiAmount: "1", decimals: 6 }],
};

// A moonpay onramp requirements answer that needs no collection and no onboarding:
// the advance straight to `ready` lets the transaction stage fire the quote.
const REQUIREMENTS_READY = { provider: "moonpay", direction: "onramp", status: "ready" };

const MOONPAY_QUOTE = {
  id: "quote_moonpay",
  provider: "moonpay",
  status: "pending",
  deliveryMode: "hosted",
  hostedUrl: "https://buy-sandbox.moonpay.com/",
};

function transferFixture(
  status: PaymentTransferSummary["status"],
  overrides: Partial<PaymentTransferSummary>
): PaymentTransferSummary {
  return {
    id: TRANSFER_ID,
    custodyWalletId: WALLET.id,
    providerWalletId: WALLET.walletId,
    status,
    signature: null,
    rampsMemo: {},
    type: "onramp",
    provider: "moonpay",
    ...overrides,
  };
}

const PROPS: UseRampWizardProps = {
  wallets: [WALLET],
  walletsError: null,
  enabledRampProviders: ["moonpay"],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
  selectedCounterparty: null,
  initialCounterpartyId: "counterparty-test",
  onExit: vi.fn(),
};

let currentTransfer: PaymentTransferSummary = transferFixture("awaiting_payment", {});
const fetchMock = vi.fn<typeof fetch>();

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

function transferStatusCalls(): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).startsWith(`/api/dashboard/payments/transfers/${TRANSFER_ID}`)
  ).length;
}

beforeEach(() => {
  // A failed quote keeps its key (APE-689), so each spec starts clean.
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  currentTransfer = transferFixture("awaiting_payment", {});
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
        Response.json({ data: { quote: MOONPAY_QUOTE, transferId: TRANSFER_ID } })
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
 * the MOONPAY provider, fund the deposit form, advance through the memo (which
 * POSTs the requirements advance and lands on the PROVIDER step), let the
 * readiness effect fire the quote POST, and wait for the transfer-status poll
 * to deliver the scenario transfer.
 */
async function driveToTransferStatus(rendered: WizardRender) {
  await act(async () => {});
  act(() => rendered.result.current.selectProvider("moonpay"));
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
    const { result } = await renderAtTransfer(transferFixture("settling", {}));

    expect(result.current.transferStatus?.status).toBe("settling");
    expect(result.current.transferStatus?.settlement).toBeUndefined();
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBeGreaterThan(callsBefore);
  });

  it("keeps the complete screen for a completed transfer and stops polling", async () => {
    const signature =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const { result } = await renderAtTransfer(
      transferFixture("completed", {
        signature,
        providerReference: "01a0ab3c-4388-7e84-a501-3b02668d715b",
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
    const { result } = await renderAtTransfer(transferFixture("failed", {}));

    expect(result.current.transferStatus?.status).toBe("failed");
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBe(callsBefore);
  });
});

describe("useOnrampWizard: Previous while the quote is in flight (APE-466)", () => {
  const WALLET_B: PaymentsDashboardWallet = {
    ...WALLET,
    id: "wallet-b",
    walletId: "provider-b",
    publicKey: "wallet-b-pubkey",
    label: "Wallet B",
  };
  // Primary presses from the deposit step to the transaction stage.
  const STEPS_TO_TRANSACTION_STAGE = 2;
  const quoteCreated = () =>
    Response.json({ data: { quote: MOONPAY_QUOTE, transferId: TRANSFER_ID } });
  const quoteFailed = () =>
    Response.json({ error: { message: "The provider is unavailable." } }, { status: 502 });

  interface QuoteCall {
    body: unknown;
    idempotencyKey: string | null;
    respond: (response: Response) => void;
  }
  /** One render of the wizard: whether it waits on a quote, and whether Previous is held. */
  interface StageRender {
    awaitingQuote: boolean;
    quoteInFlight: boolean;
  }
  let quoteCalls: QuoteCall[] = [];
  let renders: StageRender[] = [];

  beforeEach(() => {
    quoteCalls = [];
    renders = [];
    const base = fetchMock.getMockImplementation();
    if (base === undefined) {
      throw new Error("The file's beforeEach must install the default fetch mock first");
    }
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET, WALLET_B] } }));
      }
      if (url === "/api/dashboard/payments/ramps/onramp/quote" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          quoteCalls.push({
            body: JSON.parse(String(init.body)),
            idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
            respond: resolve,
          });
        });
      }
      return base(input, init);
    });
  });

  async function enterTransactionStage(rendered: WizardRender, walletId: string, amount: string) {
    act(() => rendered.result.current.setField("walletId", walletId));
    act(() => rendered.result.current.setField("amount", amount));
    await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
    for (let press = 0; press < STEPS_TO_TRANSACTION_STAGE; press += 1) {
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }
  }

  function renderWizard(): WizardRender {
    return renderHook(
      () => {
        const wizard = useOnrampWizard({ ...PROPS, wallets: [WALLET, WALLET_B] });
        renders.push({
          awaitingQuote:
            wizard.isLastStep &&
            wizard.onboarding?.status === "ready" &&
            wizard.quote === null &&
            wizard.quoteCreationError === null,
          quoteInFlight: wizard.quoteInFlight,
        });
        return wizard;
      },
      { wrapper }
    );
  }

  async function renderWithQuoteInFlight(): Promise<WizardRender> {
    const rendered = renderWizard();
    await act(async () => {});
    act(() => rendered.result.current.selectProvider("moonpay"));
    await enterTransactionStage(rendered, WALLET.id, "100");
    await waitFor(() => expect(quoteCalls).toHaveLength(1));
    expect(quoteCalls[0]?.body).toMatchObject({
      destinationCustodyWalletId: WALLET.id,
      fiatAmount: "100",
    });
    return rendered;
  }

  async function respondToQuote(index: number, response: Response) {
    await act(async () => {
      quoteCalls[index]?.respond(response);
    });
  }

  it("holds Previous from the first render on the transaction stage until the quote lands", async () => {
    const rendered = await renderWithQuoteInFlight();

    const awaiting = renders.filter((render) => render.awaitingQuote);
    expect(awaiting.length).toBeGreaterThan(0);
    expect(awaiting.filter((render) => !render.quoteInFlight)).toEqual([]);

    await respondToQuote(0, quoteCreated());
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));
    expect(rendered.result.current.quoteInFlight).toBe(false);
  });

  it("frees Previous when the quote fails and holds it again during the retry", async () => {
    const rendered = await renderWithQuoteInFlight();

    await respondToQuote(0, quoteFailed());
    await waitFor(() =>
      expect(rendered.result.current.quoteCreationError?.message).toBe(
        "The provider is unavailable."
      )
    );
    expect(rendered.result.current.quoteInFlight).toBe(false);

    act(() => rendered.result.current.retryQuoteCreation());
    expect(rendered.result.current.quoteInFlight).toBe(true);
    await waitFor(() => expect(quoteCalls).toHaveLength(2));
    await respondToQuote(1, quoteCreated());
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));
    expect(rendered.result.current.quoteInFlight).toBe(false);
  });

  // APE-689: the quote creates the transfer, so Try Again must reach the API as
  // the failed attempt's request, under its key.
  it("sends Try Again under the failed quote's Idempotency-Key", async () => {
    const rendered = await renderWithQuoteInFlight();
    await respondToQuote(0, quoteFailed());
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    act(() => rendered.result.current.retryQuoteCreation());
    await waitFor(() => expect(quoteCalls).toHaveLength(2));

    expect(quoteCalls[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(quoteCalls[1].idempotencyKey).toBe(quoteCalls[0].idempotencyKey);
    await respondToQuote(1, quoteCreated());
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));
  });

  it("quotes the edited selection after a failed quote and Previous", async () => {
    const rendered = await renderWithQuoteInFlight();
    await respondToQuote(0, quoteFailed());
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    for (let press = 0; press < STEPS_TO_TRANSACTION_STAGE; press += 1) {
      act(() => rendered.result.current.handleSecondary());
    }
    expect(rendered.result.current.stepIndex).toBe(0);
    expect(rendered.result.current.quoteCreationError).toBeNull();

    await enterTransactionStage(rendered, WALLET_B.id, "200");
    await waitFor(() => expect(quoteCalls).toHaveLength(2));
    expect(quoteCalls[1]?.body).toMatchObject({
      destinationCustodyWalletId: WALLET_B.id,
      fiatAmount: "200",
    });
    expect(quoteCalls[1].idempotencyKey).not.toBe(quoteCalls[0].idempotencyKey);
    await respondToQuote(1, quoteCreated());
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));
    expect(rendered.result.current.selectedWallet?.id).toBe(WALLET_B.id);
  });
});
