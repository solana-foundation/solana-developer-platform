// @vitest-environment jsdom

import type { PaymentRampQuote, PaymentTransferStatus, PaymentTransferSummary } from "@sdp/types";
import { address } from "@solana/kit";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DEFAULT_RAMP_PAIR } from "@/lib/ramps";
import type { OfframpWizard } from "./hooks/use-offramp-wizard";
import { OfframpRail } from "./offramp-rail";
import type { RailProps } from "./ramp-action-page";

const mocks = vi.hoisted(() => ({ wizard: null as OfframpWizard | null }));

vi.mock("./hooks/use-offramp-wizard", () => ({
  useOfframpWizard: () => {
    if (mocks.wizard === null) {
      throw new Error("Set mocks.wizard before rendering the rail.");
    }
    return mocks.wizard;
  },
}));

const DEPOSIT_ADDRESS = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

type BvnkManualQuote = Extract<
  PaymentRampQuote,
  { provider: "bvnk"; deliveryMode: "manual_instructions" }
>;

const quote: BvnkManualQuote = {
  id: "quote_bvnk",
  provider: "bvnk",
  status: "pending",
  deliveryMode: "manual_instructions",
  paymentInstructions: [
    {
      provider: "bvnk",
      kind: "crypto_deposit",
      destinationAddress: DEPOSIT_ADDRESS,
      cryptoCurrency: "USDC",
      network: "SOLANA",
      fiatCurrency: "USD",
      reference: "ref_bvnk",
      instructionsNotes: "Send only USDC on Solana.",
    },
  ],
};

function transfer(status: PaymentTransferStatus): PaymentTransferSummary {
  return {
    id: "xfr_offramp",
    custodyWalletId: "cwlt_treasury",
    providerWalletId: "wallet_treasury",
    status,
    signature: null,
    rampsMemo: {},
    type: "offramp",
    provider: "bvnk",
  };
}

const noop = (): undefined => undefined;
const asyncNoop = async (): Promise<undefined> => undefined;

function offrampWizard(overrides: Partial<OfframpWizard>): OfframpWizard {
  return {
    sourceWalletHint: null,
    pendingAgreements: null,
    acceptedAgreements: [],
    toggleAgreement: noop,
    enabledRampProviders: ["bvnk"],
    rampProviderAccess: null,
    selectedCounterparty: null,
    stepIndex: 0,
    steps: [{ id: "COMPLETE", label: "Complete", title: "Complete your payout" }],
    currentStepId: "COMPLETE",
    isLastStep: true,
    onTransactionStage: true,
    isCanceling: false,
    canProceed: true,
    collectedData: {},
    setCollectedField: noop,
    requirementFields: [],
    selectedProviderAccountId: null,
    payoutAccounts: [],
    selectPayoutAccount: noop,
    requirementsBlocker: null,
    liveWallets: [],
    walletsLoading: false,
    liveWalletsError: null,
    selectedWallet: null,
    selectedRampPair: DEFAULT_RAMP_PAIR,
    fields: { amount: "250", provider: "bvnk", walletId: "cwlt_treasury", counterpartyId: "cpty" },
    setField: noop,
    selectProvider: noop,
    quote,
    quoteTransferId: "xfr_offramp",
    memoRows: [],
    setMemoRows: noop,
    refreshQuote: asyncNoop,
    quoteCreationError: null,
    quoteCreationRetrying: false,
    retryQuoteCreation: noop,
    onboarding: null,
    isAdvancing: false,
    retryOnboarding: noop,
    hostedQuoteLoading: false,
    counterpartyDialogOpen: false,
    setCounterpartyDialogOpen: noop,
    handlePrimary: asyncNoop,
    handleSecondary: noop,
    finish: noop,
    handlePairChange: noop,
    handleCounterpartyCreated: noop,
    summaryDetails: [],
    transferStatus: transfer("awaiting_payment"),
    transferStatusLoading: false,
    sourceTokenMint: "mint_usdc",
    depositTarget: { destinationAddress: DEPOSIT_ADDRESS, amount: "250" },
    hasCryptoDepositInstruction: true,
    canSendOnchain: true,
    onchainSendLoading: false,
    onchainSendResult: null,
    heldApprovalRequestId: null,
    sendCryptoToDeposit: asyncNoop,
    quoteExpired: false,
    ...overrides,
  };
}

const railProps: RailProps = {
  wallets: [],
  walletsError: null,
  issuedTokenSymbolsByMint: {},
  enabledRampProviders: ["bvnk"],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
  selectedCounterparty: null,
  counterpartyId: "cpty",
  counterpartyName: "Ada Trading",
  methodLabel: "Bank account",
  preSteps: [],
  onExit: noop,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderRail(wizard: OfframpWizard) {
  mocks.wizard = wizard;
  return render(<OfframpRail {...railProps} />, { wrapper });
}

afterEach(() => {
  cleanup();
  mocks.wizard = null;
});

describe("OfframpRail final step", () => {
  it("asks for the send while the deposit is unfunded", () => {
    const { container } = renderRail(offrampWizard({}));

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Complete your payout");
    expect(screen.queryByText("Waiting to send")).not.toBeNull();
    expect(screen.queryByText(/before the quote expires/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send 250 USDC" })).toHaveProperty("disabled", false);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("says a send held for approval is waiting, once, and links the request", () => {
    renderRail(
      offrampWizard({
        onchainSendResult: { kind: "approval_pending", approvalRequestId: "apr_offramp" },
        heldApprovalRequestId: "apr_offramp",
      })
    );

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Waiting for approval");
    expect(screen.getAllByText("Waiting for approval")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "View approval request" }).getAttribute("href")).toBe(
      "/dashboard/approvals/apr_offramp"
    );
    expect(screen.queryByText(/Once approved, 250 USDC is sent/)).not.toBeNull();
    expect(screen.queryByText(/If the quote expires first/)).not.toBeNull();
  });

  it("drops the pill and the send prompt while a send is held", () => {
    const { container } = renderRail(
      offrampWizard({
        onchainSendResult: { kind: "approval_pending", approvalRequestId: "apr_offramp" },
        heldApprovalRequestId: "apr_offramp",
        transferStatus: undefined,
      })
    );

    expect(screen.queryByText("Preparing transfer status")).toBeNull();
    expect(screen.queryByText("Waiting to send")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText(/before the quote expires/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Send 250 USDC/ })).toBeNull();
  });

  it("returns to the polled status once the approved send lands", () => {
    renderRail(
      offrampWizard({
        onchainSendResult: { kind: "approval_pending", approvalRequestId: "apr_offramp" },
        heldApprovalRequestId: null,
        transferStatus: transfer("settling"),
      })
    );

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Complete your payout");
    expect(screen.queryByText("Sending payout")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "View approval request" })).toBeNull();
  });
});
