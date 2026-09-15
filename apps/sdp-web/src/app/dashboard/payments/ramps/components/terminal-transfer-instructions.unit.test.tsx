import type { PaymentTransferStatus } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
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

function renderManualStep(
  direction: RampDirection,
  status: PaymentTransferStatus | undefined,
  paymentInstructions: Record<string, string> | null
): string {
  const wizard = {
    currentStepId: direction === "onramp" ? "PROVIDER" : "COMPLETE",
    fields: { amount: "100", provider: "bvnk", walletId: "" },
    collectedData: {},
    liveWallets: [],
    memoRows: [],
    quote: { provider: "bvnk", deliveryMode: "manual_instructions", paymentInstructions },
    transferStatus:
      status === undefined
        ? undefined
        : {
            id: "xfr_terminal",
            custodyWalletId: "cwlt_terminal",
            providerWalletId: "wallet_terminal",
            status,
            signature: null,
            rampsMemo: {},
            type: direction,
            provider: "bvnk",
          },
    selectedRampPair: { assetRail: "usdc.solana", fiatCurrency: "EUR" },
  };

  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {direction === "onramp" ? (
        <OnrampStepContent wizard={wizard as unknown as OnrampWizard} />
      ) : (
        <OfframpStepContent wizard={wizard as unknown as OfframpWizard} />
      )}
    </I18nProvider>
  );
}

const INSTRUCTIONS = { reference: "REF-1" };

describe.each(["onramp", "offramp"] satisfies RampDirection[])(
  "%s manual-instructions step",
  (direction) => {
    it.each(TERMINAL)("withdraws the funding instructions once the transfer is %s", (status) => {
      const markup = renderManualStep(direction, status, INSTRUCTIONS);

      expect(markup).not.toContain(MANUAL_INSTRUCTIONS_STUB);
      expect(markup).not.toContain("missing payment instructions");
    });

    it.each(FUNDABLE)("keeps the funding instructions while %s", (status) => {
      expect(renderManualStep(direction, status, INSTRUCTIONS)).toContain(MANUAL_INSTRUCTIONS_STUB);
    });

    it("keeps the funding instructions before the first status arrives", () => {
      expect(renderManualStep(direction, undefined, INSTRUCTIONS)).toContain(
        MANUAL_INSTRUCTIONS_STUB
      );
    });

    it("reports a canceled transfer, not a quote defect, when instructions are absent", () => {
      const markup = renderManualStep(direction, "canceled", null);

      expect(markup).toContain("Transfer canceled");
      expect(markup).not.toContain("missing payment instructions");
    });

    it("still reports the quote defect while the transfer can settle", () => {
      expect(renderManualStep(direction, "awaiting_payment", null)).toContain(
        "missing payment instructions"
      );
    });
  }
);
