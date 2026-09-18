import type {
  PaymentRampQuote,
  PaymentRampQuoteCurrency,
  PaymentTransferStatus,
  PaymentTransferSummary,
} from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DEFAULT_RAMP_PAIR } from "@/lib/ramps";
import type { OfframpStepId, OfframpWizard } from "../hooks/use-offramp-wizard";
import type { OnrampStepId, OnrampWizard } from "../hooks/use-onramp-wizard";
import type { useRampWizard } from "../hooks/use-ramp-wizard";
import { OfframpStepContent } from "./offramp-step-content";
import { OnrampStepContent } from "./onramp-step-content";

const MANUAL_INSTRUCTIONS_STUB = "manual-instructions-stub";

vi.mock("./manual-instructions-quote", () => ({
  ManualInstructionsQuote: () => <div>manual-instructions-stub</div>,
}));
vi.mock("./coinbase/quote-summary", () => ({ CoinbaseQuoteSummary: () => null }));
vi.mock("./coinbase/ramp-frame", () => ({ CoinbaseRampFrame: () => null }));
vi.mock("./memo-step-content", () => ({ MemoStepContent: () => null }));
vi.mock("./moneygram-ramp-widget", () => ({ MoneygramRampWidget: () => null }));
vi.mock("./moonpay-ramp-frame", () => ({ MoonpayRampFrame: () => null }));
vi.mock("./ramp-complete-screen", () => ({ RampCompleteScreen: () => null }));
vi.mock("./ramp-onboarding-panel", () => ({ RampOnboardingPanel: () => null }));
vi.mock("./ramp-pair-provider-selector", () => ({ RampPairProviderSelector: () => null }));
vi.mock("./ramp-quote-error", () => ({ RampQuoteError: () => null }));
vi.mock("./ramp-quote-skeleton", () => ({ RampQuoteSkeleton: () => null }));
vi.mock("./requirements-fields", () => ({ RequirementsFields: () => null }));
vi.mock("./stripe-onramp-frame", () => ({ StripeOnrampFrame: () => null }));
vi.mock("./wallet-asset-breakdown", () => ({ WalletAssetBreakdown: () => null }));
vi.mock("@/components/ui/combobox", () => ({ Combobox: () => null }));

const TERMINAL = ["canceled", "failed", "expired"] satisfies PaymentTransferStatus[];
const FUNDABLE = [
  "pending",
  "awaiting_payment",
  "processing",
  "settling",
] satisfies PaymentTransferStatus[];

type ManualQuote = Extract<
  PaymentRampQuote,
  { provider: "lightspark"; deliveryMode: "manual_instructions" }
>;

const USD: PaymentRampQuoteCurrency = { code: "USD", decimals: 2 };
const USDC: PaymentRampQuoteCurrency = { code: "USDC", decimals: 6 };

function manualQuote(paymentInstructions: ManualQuote["paymentInstructions"]): ManualQuote {
  return {
    id: "quote_manual",
    provider: "lightspark",
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions,
    sendingCurrency: USD,
    receivingCurrency: USDC,
    feeCurrency: USD,
  };
}

function transferSummary(
  direction: RampDirection,
  status: PaymentTransferStatus
): PaymentTransferSummary {
  return {
    id: "xfr_manual",
    custodyWalletId: "cwlt_manual",
    providerWalletId: "wallet_manual",
    status,
    signature: null,
    rampsMemo: {},
    type: direction,
    provider: "lightspark",
  };
}

const noop = (): undefined => undefined;
const asyncNoop = async (): Promise<undefined> => undefined;

function sharedWizard<TId extends string>(
  currentStepId: TId,
  quote: ManualQuote
): ReturnType<typeof useRampWizard<TId>> {
  return {
    enabledRampProviders: ["lightspark"],
    rampProviderAccess: null,
    selectedCounterparty: null,
    stepIndex: 0,
    steps: [{ id: currentStepId, label: "Step", title: "Step" }],
    currentStepId,
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
    fields: { amount: "100", provider: "lightspark", walletId: "", counterpartyId: "" },
    setField: noop,
    selectProvider: noop,
    quote,
    quoteTransferId: "xfr_manual",
    memoRows: [],
    setMemoRows: noop,
    refreshQuote: asyncNoop,
    quoteCreationError: null,
    quoteCreationRetrying: false,
    retryQuoteCreation: noop,
    onboarding: null,
    isAdvancing: false,
    retryOnboarding: noop,
    pendingAgreements: null,
    acceptedAgreements: [],
    toggleAgreement: noop,
    hostedQuoteLoading: false,
    counterpartyDialogOpen: false,
    setCounterpartyDialogOpen: noop,
    handlePrimary: asyncNoop,
    handleSecondary: noop,
    finish: noop,
    handlePairChange: noop,
    handleCounterpartyCreated: noop,
  };
}

function onrampWizard(
  quote: ManualQuote,
  transferStatus: PaymentTransferSummary | undefined
): OnrampWizard {
  return {
    ...sharedWizard<OnrampStepId>("PROVIDER", quote),
    summaryDetails: [],
    transferStatus,
    transferStatusLoading: false,
    quoteSimulationLoading: false,
    quoteSimulationSucceeded: false,
    simulateCurrentQuote: asyncNoop,
  };
}

function offrampWizard(
  quote: ManualQuote,
  transferStatus: PaymentTransferSummary | undefined
): OfframpWizard {
  return {
    ...sharedWizard<OfframpStepId>("COMPLETE", quote),
    sourceWalletHint: null,
    summaryDetails: [],
    transferStatus,
    transferStatusLoading: false,
    sourceTokenMint: null,
    depositTarget: null,
    hasCryptoDepositInstruction: false,
    canSendOnchain: false,
    onchainSendLoading: false,
    onchainSendResult: null,
    heldApprovalRequestId: null,
    sendCryptoToDeposit: asyncNoop,
    quoteExpired: false,
  };
}

function renderManualStep(
  direction: RampDirection,
  status: PaymentTransferStatus | undefined,
  paymentInstructions: ManualQuote["paymentInstructions"]
): string {
  const quote = manualQuote(paymentInstructions);
  const transferStatus = status === undefined ? undefined : transferSummary(direction, status);

  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {direction === "onramp" ? (
        <OnrampStepContent wizard={onrampWizard(quote, transferStatus)} />
      ) : (
        <OfframpStepContent wizard={offrampWizard(quote, transferStatus)} />
      )}
    </I18nProvider>
  );
}

describe.each(["onramp", "offramp"] satisfies RampDirection[])(
  "%s manual-instructions step",
  (direction) => {
    it.each(TERMINAL)("withdraws the funding instructions once the transfer is %s", (status) => {
      const markup = renderManualStep(direction, status, []);

      expect(markup).not.toContain(MANUAL_INSTRUCTIONS_STUB);
      expect(markup).not.toContain("missing payment instructions");
    });

    it.each(FUNDABLE)("keeps the funding instructions while %s", (status) => {
      expect(renderManualStep(direction, status, [])).toContain(MANUAL_INSTRUCTIONS_STUB);
    });

    it("keeps the funding instructions before the first status arrives", () => {
      expect(renderManualStep(direction, undefined, [])).toContain(MANUAL_INSTRUCTIONS_STUB);
    });

    it("reports a canceled transfer, not a quote defect, when instructions are absent", () => {
      const markup = renderManualStep(direction, "canceled", undefined);

      expect(markup).toContain("Transfer canceled");
      expect(markup).not.toContain("missing payment instructions");
    });

    it("still reports the quote defect while the transfer can settle", () => {
      expect(renderManualStep(direction, "awaiting_payment", undefined)).toContain(
        "missing payment instructions"
      );
    });
  }
);
