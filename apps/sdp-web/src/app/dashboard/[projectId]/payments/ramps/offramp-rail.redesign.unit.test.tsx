// @vitest-environment jsdom

import type { PaymentRampQuote, PaymentTransferStatus, PaymentTransferSummary } from "@sdp/types";
import { address } from "@solana/kit";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DEFAULT_RAMP_PAIR } from "@/lib/ramps";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import type { OfframpWizard } from "./hooks/use-offramp-wizard.redesign";
import { OfframpRail } from "./offramp-rail.redesign";
import type { RailProps } from "./ramp-action-page.redesign";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
});

const mocks = vi.hoisted(() => ({ wizard: null as OfframpWizard | null }));

vi.mock("./hooks/use-offramp-wizard.redesign", () => ({
  useOfframpWizard: () => {
    if (mocks.wizard === null) {
      throw new Error("Set mocks.wizard before rendering the rail.");
    }
    return mocks.wizard;
  },
}));

const DEPOSIT_ADDRESS = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

const quote: PaymentRampQuote = {
  id: "quote_moonpay",
  provider: "moonpay",
  status: "pending",
  deliveryMode: "hosted",
  hostedUrl: "https://sell-sandbox.moonpay.com/",
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
    provider: "moonpay",
  };
}

const noop = (): undefined => undefined;
const asyncNoop = async (): Promise<undefined> => undefined;

function offrampWizard(overrides: Partial<OfframpWizard>): OfframpWizard {
  return {
    sourceWalletHint: null,
    enabledRampProviders: ["moonpay"],
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
    requirementsBlocker: null,
    liveWallets: [],
    walletsLoading: false,
    liveWalletsError: null,
    selectedWallet: null,
    selectedRampPair: DEFAULT_RAMP_PAIR,
    fields: {
      amount: "250",
      provider: "moonpay",
      walletId: "cwlt_treasury",
      counterpartyId: "cpty",
    },
    setField: noop,
    selectProvider: noop,
    quote,
    quoteTransferId: "xfr_offramp",
    memoRows: [],
    setMemoRows: noop,
    quoteCreationError: null,
    quoteCreationRetrying: false,
    quoteInFlight: false,
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
    hasCryptoDepositInstruction: false,
    canSendOnchain: true,
    onchainSendLoading: false,
    onchainSendResult: null,
    sendCryptoToDeposit: asyncNoop,
    ...overrides,
  };
}

const railProps: RailProps = {
  wallets: [],
  walletsError: null,
  issuedTokenSymbolsByMint: {},
  enabledRampProviders: ["moonpay"],
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
    expect(
      container.querySelector('iframe[src="https://sell-sandbox.moonpay.com/"]')
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send 250 USDC" })).toHaveProperty("disabled", false);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("OfframpRail final step before the quote lands", () => {
  const awaitingQuote: Partial<OfframpWizard> = {
    stepIndex: 1,
    steps: [
      { id: "MEMO", label: "Memo", title: "Add a memo" },
      { id: "COMPLETE", label: "Complete", title: "Complete your payout" },
    ],
    onTransactionStage: false,
    quote: null,
    quoteTransferId: null,
    transferStatus: undefined,
    depositTarget: null,
    hasCryptoDepositInstruction: false,
  };

  it("disables Previous while the quote is in flight", () => {
    renderRail(offrampWizard({ ...awaitingQuote, quoteInFlight: true }));

    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);
  });

  it("frees Previous once the quote failed", () => {
    renderRail(
      offrampWizard({ ...awaitingQuote, quoteCreationError: new Error("Provider unavailable") })
    );

    expect(screen.getByRole("button", { name: "Previous" })).toHaveProperty("disabled", false);
  });
});
