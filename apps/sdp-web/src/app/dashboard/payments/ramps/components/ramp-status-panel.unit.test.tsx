import type { PaymentTransferStatus } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RampStatusInline } from "./ramp-status-panel";

function renderStatus(status: PaymentTransferStatus): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RampStatusInline
        direction="onramp"
        hosted
        transfer={{
          id: "xfr_status",
          status,
          signature: null,
          rampsMemo: {},
          type: "onramp",
          provider: "moonpay",
        }}
      />
    </I18nProvider>
  );
}

describe("RampStatusInline", () => {
  it("shows a success tick without a spinner for completed transfers", () => {
    const markup = renderStatus("completed");

    expect(markup).toContain("text-success");
    expect(markup).not.toContain("animate-spin");
  });

  it.each(["failed", "expired", "canceled"] satisfies PaymentTransferStatus[])(
    "shows an error icon without a spinner for terminal status %s",
    (status) => {
      const markup = renderStatus(status);

      expect(markup).toContain("text-error");
      expect(markup).not.toContain("animate-spin");
    }
  );

  it("keeps the spinner for non-terminal transfers", () => {
    expect(renderStatus("settling")).toContain("animate-spin");
  });
});
