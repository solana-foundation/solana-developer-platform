import type { PaymentTransferStatus } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { OfframpWizard } from "../hooks/use-offramp-wizard";
import type { OnrampWizard } from "../hooks/use-onramp-wizard";
import { OfframpStepContent } from "./offramp-step-content";
import { OnrampStepContent } from "./onramp-step-content";
import { isTerminalTransferStatus, RampStatusInline } from "./ramp-status-panel";

const TERMINAL: PaymentTransferStatus[] = ["canceled", "failed", "expired"];
const FUNDABLE: PaymentTransferStatus[] = ["pending", "awaiting_payment", "processing", "settling"];

function renderCanceled(direction: "onramp" | "offramp"): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RampStatusInline
        direction={direction}
        hosted={false}
        transfer={{
          id: "xfr_canceled",
          custodyWalletId: "cwlt_canceled",
          providerWalletId: "wallet_canceled",
          status: "canceled",
          signature: null,
          rampsMemo: {},
          type: direction,
          provider: "bvnk",
        }}
      />
    </I18nProvider>
  );
}

describe("isTerminalTransferStatus", () => {
  it.each(TERMINAL)("treats %s as terminal so instructions are withdrawn", (status) => {
    expect(isTerminalTransferStatus(status)).toBe(true);
  });

  it.each(FUNDABLE)("keeps instructions available while %s", (status) => {
    expect(isTerminalTransferStatus(status)).toBe(false);
  });

  it("keeps instructions available when no transfer exists yet", () => {
    // The quote screen renders before the first status arrives; withdrawing then would
    // hide the instructions the customer is waiting for.
    expect(isTerminalTransferStatus(undefined)).toBe(false);
  });

  it("does not withdraw instructions once a transfer has completed", () => {
    // `completed` is terminal in the lifecycle sense, but the completion screen owns that
    // state — classing it here would suppress the wrong panel.
    expect(isTerminalTransferStatus("completed")).toBe(false);
  });
});

describe("cancelled transfer copy", () => {
  it.each(["onramp", "offramp"] as const)(
    "does not attribute a cancellation to the provider (%s)",
    (direction) => {
      // SDP cancels locally and tells the provider nothing, so rendering it as the
      // provider's status blames them for a decision they never made.
      const markup = renderCanceled(direction);

      expect(markup).not.toContain("Current provider status");
      expect(markup).toContain("canceled");
    }
  );

  it("tells the customer the instructions no longer apply", () => {
    expect(renderCanceled("offramp")).toContain("no longer apply");
  });
});

/**
 * A quote whose instructions never arrived, on a transfer that is already dead. The
 * missing-instructions guard used to run first and report a quote defect, hiding the
 * fact that the transfer itself is terminal.
 */
function renderStepContent(direction: "onramp" | "offramp", status: PaymentTransferStatus): string {
  const wizard = {
    currentStepId: direction === "onramp" ? "PROVIDER" : "COMPLETE",
    fields: { amount: "100", provider: "bvnk", walletId: "" },
    collectedData: {},
    liveWallets: [],
    memoRows: [],
    quote: {
      provider: "bvnk",
      deliveryMode: "manual_instructions",
      paymentInstructions: null,
    },
    transferStatus: {
      id: "xfr_ordering",
      custodyWalletId: "cwlt_ordering",
      providerWalletId: "wallet_ordering",
      status,
      signature: null,
      rampsMemo: {},
      type: direction,
      provider: "bvnk",
    },
    selectedRampPair: { assetRail: "usdc-solana", fiatCurrency: "EUR" },
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

describe("terminal guard ordering", () => {
  it.each(["onramp", "offramp"] as const)(
    "reports a dead transfer, not a quote defect, when instructions are absent (%s)",
    (direction) => {
      const markup = renderStepContent(direction, "canceled");

      expect(markup).not.toContain("missing payment instructions");
      expect(markup).toContain("Transfer canceled");
    }
  );

  it.each(["onramp", "offramp"] as const)(
    "still reports the quote defect while the transfer can settle (%s)",
    (direction) => {
      // Ordering must not swallow the error: a fundable transfer with no instructions is a
      // quote-configuration problem, and that is what the screen should say.
      expect(renderStepContent(direction, "awaiting_payment")).toContain(
        "missing payment instructions"
      );
    }
  );
});
