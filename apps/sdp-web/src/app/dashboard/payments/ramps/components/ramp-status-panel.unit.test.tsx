import type { PaymentTransferStatus } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
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
