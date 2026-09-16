/**
 * The status badge. `funded` reads "Ready to settle", which the program only
 * honours inside the window, so the API's availability refines it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DvpStatusBadge } from "./dvp-status";
import type { DvpSettlementAvailability, DvpTradeStatus } from "./dvp-trade";

function badge(status: DvpTradeStatus, availability: DvpSettlementAvailability | null): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpStatusBadge settlementAvailability={availability} status={status} />
    </I18nProvider>
  );
}

describe("DvpStatusBadge", () => {
  it("says Ready to settle for a funded trade inside its window", () => {
    expect(badge("funded", "available")).toContain("Ready to settle");
  });

  // Before the earliest settlement time Settle is refused, so the badge must not
  // promise it.
  it("says Funded, not Ready to settle, before the earliest settlement time", () => {
    const html = badge("funded", "too_early");

    expect(html).toContain("Funded");
    expect(html).not.toContain("Ready to settle");
  });

  it("names every other status as it is", () => {
    expect(badge("expired", "expired")).toContain("Expired");
    expect(badge("created", "unfunded")).toContain("Awaiting funding");
    expect(badge("settled", null)).toContain("Settled");
  });
});
