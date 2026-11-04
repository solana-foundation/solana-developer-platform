// @vitest-environment jsdom

import type {
  PaymentRampQuote,
  PaymentsDashboardWallet,
  PaymentTransferStatus,
  PaymentTransferSummary,
} from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { RenderHookResult } from "@testing-library/react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnrampStepContent } from "@/app/(session)/dashboard/[projectId]/payments/ramps/components/onramp-step-content";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
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
  useAuth: () => ({ orgId: "org-test", userId: "user-test" }),
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

let currentTransfer: PaymentTransferSummary = transferFixture("awaiting_payment");
let currentQuote: object = MOONPAY_QUOTE;
let currentRequirements: object = REQUIREMENTS_READY;
let demoMode = false;
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
        <PaymentsDemoProvider value={demoMode}>
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {children}
          </SWRConfig>
        </PaymentsDemoProvider>
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
  currentTransfer = transferFixture("awaiting_payment");
  currentQuote = MOONPAY_QUOTE;
  currentRequirements = REQUIREMENTS_READY;
  demoMode = false;
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
      return Promise.resolve(Response.json({ data: currentRequirements }));
    }
    if (url === "/api/dashboard/payments/ramps/onramp/quote" && method === "POST") {
      return Promise.resolve(
        Response.json({ data: { quote: currentQuote, transferId: TRANSFER_ID } })
      );
    }
    if (url.startsWith(`/api/dashboard/payments/transfers/${TRANSFER_ID}`)) {
      return Promise.resolve(Response.json({ data: { transfer: currentTransfer } }));
    }
    if (url === "/api/dashboard/payments/ramps/sandbox/simulate" && method === "POST") {
      // The API settles a sandbox Hercle order and answers with no body.
      return Promise.resolve(new Response(null, { status: 204 }));
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
 * POSTs the requirements advance and lands on the REVIEW step), continue past
 * the review to the PROVIDER step, let the readiness effect fire the quote
 * POST, and wait for the transfer-status poll to deliver the scenario transfer.
 */
async function driveToTransferStatus(rendered: WizardRender, provider: RampProviderId = "moonpay") {
  await act(async () => {});
  act(() => rendered.result.current.selectProvider(provider));
  act(() => rendered.result.current.setField("amount", "100"));
  act(() => rendered.result.current.setField("walletId", WALLET.id));
  await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
  // Nothing is quoted while the user reviews; the quote waits for the last step.
  expect(rendered.result.current.currentStepId).toBe("REVIEW");
  expect(rendered.result.current.quoteTransferId).toBeNull();
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
    const { result } = await renderAtTransfer(transferFixture("failed"));

    expect(result.current.transferStatus?.status).toBe("failed");
    expect(result.current.showCompleteScreen).toBe(false);

    const callsBefore = transferStatusCalls();
    await allowPollingTick();
    expect(transferStatusCalls()).toBe(callsBefore);
  });
});

describe("useOnrampWizard — a provider that verifies the business first", () => {
  const HERCLE_VERIFYING = {
    provider: "hercle",
    direction: "onramp",
    status: "customer_verifying",
  };
  const HERCLE_READY = { provider: "hercle", direction: "onramp", status: "ready" };
  const HERCLE_QUOTE = {
    id: "ord_hercle",
    provider: "hercle",
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [],
  };

  function quoteCalls(): number {
    return fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/dashboard/payments/ramps/onramp/quote"
    ).length;
  }

  it("holds the quote while Hercle reviews the business, and quotes once it approves", async () => {
    currentRequirements = HERCLE_VERIFYING;
    currentQuote = HERCLE_QUOTE;
    const rendered = renderHook(
      () => useOnrampWizard({ ...PROPS, enabledRampProviders: ["hercle"] }),
      { wrapper }
    );
    await act(async () => {});
    act(() => rendered.result.current.selectProvider("hercle"));
    act(() => rendered.result.current.setField("amount", "100"));
    act(() => rendered.result.current.setField("walletId", WALLET.id));
    await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
    // Details, then the memo (which advances the requirements), then the review.
    for (let press = 0; press < 3; press += 1) {
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }

    expect(rendered.result.current.currentStepId).toBe("PROVIDER");
    expect(rendered.result.current.onboarding).toEqual(HERCLE_VERIFYING);
    // A full poll interval while Hercle still reviews: no order is opened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4300));
    });
    expect(quoteCalls()).toBe(0);

    currentRequirements = HERCLE_READY;
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID), {
      timeout: 6000,
    });
    expect(rendered.result.current.onboarding).toEqual(HERCLE_READY);
    expect(quoteCalls()).toBe(1);
  }, 20_000);
});

describe("useOnrampWizard — sandbox settlement on request", () => {
  const HERCLE_READY = { provider: "hercle", direction: "onramp", status: "ready" };
  const HERCLE_QUOTE = {
    id: "ord_hercle",
    provider: "hercle",
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [],
  };

  function simulateCalls() {
    return fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/dashboard/payments/ramps/sandbox/simulate"
    );
  }

  async function renderHercleDeposit(): Promise<WizardRender> {
    currentRequirements = HERCLE_READY;
    currentQuote = HERCLE_QUOTE;
    currentTransfer = transferFixture("awaiting_payment", { provider: "hercle" });
    const rendered = renderHook(
      () => useOnrampWizard({ ...PROPS, enabledRampProviders: ["hercle"] }),
      { wrapper }
    );
    await driveToTransferStatus(rendered, "hercle");
    return rendered;
  }

  it("offers a sandbox Hercle deposit awaiting its wire, and re-reads the transfer after the 204", async () => {
    const rendered = await renderHercleDeposit();
    expect(rendered.result.current.simulateAvailable).toBe(true);

    const readsBefore = transferStatusCalls();
    currentTransfer = transferFixture("settling", { provider: "hercle" });
    await act(async () => {
      await rendered.result.current.simulateCurrentQuote();
    });

    expect(simulateCalls()).toHaveLength(1);
    expect(JSON.parse(String(simulateCalls()[0]?.[1]?.body))).toEqual({
      transferId: TRANSFER_ID,
    });
    expect(rendered.result.current.quoteSimulationSucceeded).toBe(true);
    expect(mocks.toastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(rendered.result.current.transferStatus?.status).toBe("settling"));
    expect(transferStatusCalls()).toBeGreaterThan(readsBefore);
  });

  it("offers a Hercle order that is still the quote's pending transfer", async () => {
    currentRequirements = HERCLE_READY;
    currentQuote = HERCLE_QUOTE;
    currentTransfer = transferFixture("pending", { provider: "hercle" });
    const rendered = renderHook(
      () => useOnrampWizard({ ...PROPS, enabledRampProviders: ["hercle"] }),
      { wrapper }
    );
    await driveToTransferStatus(rendered, "hercle");

    expect(rendered.result.current.transferStatus?.status).toBe("pending");
    expect(rendered.result.current.simulateAvailable).toBe(true);
  });

  it("offers nothing once the transfer no longer waits for its wire", async () => {
    currentRequirements = HERCLE_READY;
    currentQuote = HERCLE_QUOTE;
    currentTransfer = transferFixture("settling", { provider: "hercle" });
    const rendered = renderHook(
      () => useOnrampWizard({ ...PROPS, enabledRampProviders: ["hercle"] }),
      { wrapper }
    );
    await driveToTransferStatus(rendered, "hercle");

    expect(rendered.result.current.simulateAvailable).toBe(false);
  });

  it("offers nothing for a provider the API does not settle on request", async () => {
    const rendered = renderHook(() => useOnrampWizard(PROPS), { wrapper });
    await driveToTransferStatus(rendered);

    expect(rendered.result.current.transferStatus?.status).toBe("awaiting_payment");
    expect(rendered.result.current.simulateAvailable).toBe(false);
    await act(async () => {
      await rendered.result.current.simulateCurrentQuote();
    });
    expect(simulateCalls()).toHaveLength(0);
  });
});

describe("useOnrampWizard — a Hercle deposit's provider step", () => {
  const HERCLE_READY = { provider: "hercle", direction: "onramp", status: "ready" };
  const IBAN = "CH9300762011623852957";
  const HERCLE_QUOTE = {
    id: "ord_hercle",
    provider: "hercle",
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [
      {
        provider: "hercle",
        kind: "fiat_funding",
        fiatCurrency: "USD",
        bankAccount: { iban: IBAN, paymentReference: "HRC-ORD-1", payerAccountHolder: "Acme AG" },
        instructionsNotes: "Wire 100.00 USD from a bank account held by Acme AG.",
      },
    ],
  } as const satisfies PaymentRampQuote;
  const DELIVERY =
    "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";

  async function renderProviderStep(transfer: PaymentTransferSummary): Promise<void> {
    currentRequirements = HERCLE_READY;
    currentQuote = HERCLE_QUOTE;
    currentTransfer = transfer;
    const rendered = renderHook(
      () => useOnrampWizard({ ...PROPS, enabledRampProviders: ["hercle"] }),
      { wrapper }
    );
    await driveToTransferStatus(rendered, "hercle");
    render(<OnrampStepContent wizard={rendered.result.current} />, { wrapper });
  }

  it.each(["pending", "awaiting_payment"] satisfies PaymentTransferStatus[])(
    "shows the wire instructions while SDP awaits the wire (%s)",
    async (status) => {
      await renderProviderStep(transferFixture(status, { provider: "hercle" }));

      expect(screen.getByText("Waiting for funding")).toBeTruthy();
      expect(screen.getByText(IBAN)).toBeTruthy();
    }
  );

  it.each([
    { status: "settling", signature: DELIVERY, shows: "Confirming delivery" },
    { status: "completed", signature: DELIVERY, shows: "Onchain transaction" },
    { status: "failed", signature: null, shows: "Deposit failed" },
    { status: "expired", signature: null, shows: "Quote expired" },
  ] satisfies { status: PaymentTransferStatus; signature: string | null; shows: string }[])(
    "replaces the wire instructions once the transfer is $status",
    async ({ status, signature, shows }) => {
      await renderProviderStep(transferFixture(status, { provider: "hercle", signature }));

      expect(screen.getByText(shows)).toBeTruthy();
      expect(screen.queryByText("Waiting for funding")).toBeNull();
      expect(screen.queryByText(IBAN)).toBeNull();
    }
  );
});

describe("useOnrampWizard — demo funding simulation", () => {
  it("simulates the quoted transfer by its transferId", async () => {
    demoMode = true;
    const rendered = renderHook(() => useOnrampWizard(PROPS), { wrapper });
    await driveToTransferStatus(rendered);
    await act(async () => {
      await rendered.result.current.simulateCurrentQuote();
    });
    const calls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/dashboard/payments/ramps/sandbox/simulate"
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ transferId: TRANSFER_ID });
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
  const STEPS_TO_TRANSACTION_STAGE = 3;
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

  it("waits on the transaction stage for a complete selection, with Previous free", async () => {
    const rendered = renderWizard();
    await act(async () => {});
    act(() => rendered.result.current.selectProvider("moonpay"));
    act(() => rendered.result.current.setField("walletId", WALLET.id));
    act(() => rendered.result.current.setField("amount", "100"));
    await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
    for (let press = 0; press < STEPS_TO_TRANSACTION_STAGE - 1; press += 1) {
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }
    // The review step has no gate, so this stands in for a selection that turns incomplete
    // before the stage, such as a wallet leaving the live list.
    act(() => rendered.result.current.setField("amount", ""));
    await act(async () => {
      await rendered.result.current.handlePrimary();
    });
    expect(rendered.result.current.isLastStep).toBe(true);
    expect(rendered.result.current.quoteInFlight).toBe(false);

    act(() => rendered.result.current.setField("amount", "100"));
    await waitFor(() => expect(quoteCalls).toHaveLength(1));
    expect(rendered.result.current.quoteInFlight).toBe(true);
  });
});
