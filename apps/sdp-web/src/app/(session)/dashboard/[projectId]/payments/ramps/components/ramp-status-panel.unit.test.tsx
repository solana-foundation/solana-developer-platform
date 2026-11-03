import type {
  PaymentTransferStatus,
  PaymentTransferSummary,
  RampDirection,
} from "@sdp/types/payments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RampStatusInline } from "./ramp-status-panel";

function renderStatus(status: PaymentTransferStatus, direction: RampDirection): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RampStatusInline
        direction={direction}
        hosted
        transfer={{
          id: "xfr_status",
          custodyWalletId: "cwlt_status",
          providerWalletId: "wallet_status",
          status,
          signature: null,
          rampsMemo: {},
          type: direction,
          provider: "moonpay",
        }}
      />
    </I18nProvider>
  );
}

describe("RampStatusInline", () => {
  it("shows a success tick without a spinner for completed transfers", () => {
    const markup = renderStatus("completed", "onramp");

    expect(markup).toContain("text-success");
    expect(markup).not.toContain("animate-spin");
  });

  it.each(["failed", "expired", "canceled"] satisfies PaymentTransferStatus[])(
    "shows an error icon without a spinner for terminal status %s",
    (status) => {
      const markup = renderStatus(status, "onramp");

      expect(markup).toContain("text-error");
      expect(markup).not.toContain("animate-spin");
    }
  );

  it("keeps the spinner for non-terminal transfers", () => {
    expect(renderStatus("settling", "onramp")).toContain("animate-spin");
  });
});

describe("RampStatusInline phases", () => {
  function renderTransfer(transfer: Partial<PaymentTransferSummary>, direction: RampDirection) {
    return renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <RampStatusInline
          direction={direction}
          hosted
          transfer={{
            id: "xfr_phase",
            custodyWalletId: "cwlt_phase",
            providerWalletId: "wallet_phase",
            status: "pending",
            signature: null,
            rampsMemo: {},
            type: direction,
            provider: "moonpay",
            ...transfer,
          }}
        />
      </I18nProvider>
    );
  }

  it("does not spin while the customer confirms the sale in the provider window", () => {
    const markup = renderTransfer({ status: "pending" }, "offramp");

    expect(markup).toContain("Confirm the sale in MoonPay");
    expect(markup).not.toContain("animate-spin");
  });

  it("reads a held delivery as needing review, without a spinner", () => {
    const markup = renderTransfer(
      {
        status: "settling",
        signature: "sig",
        deliveryMismatch: { reason: "transaction_not_found", checkedAt: "2026-10-20T01:14:00Z" },
      },
      "onramp"
    );

    expect(markup).toContain("Delivery needs review");
    expect(markup).toContain("text-warning");
    expect(markup).not.toContain("animate-spin");
  });
});

describe("canceled transfer copy", () => {
  it.each(["onramp", "offramp"] satisfies RampDirection[])(
    "does not attribute a local cancellation to the provider (%s)",
    (direction) => {
      const markup = renderStatus("canceled", direction);

      expect(markup).not.toContain("Current provider status");
      expect(markup).toContain("Transfer canceled");
      expect(markup).toContain("no longer apply");
    }
  );
});
