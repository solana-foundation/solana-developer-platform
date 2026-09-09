/**
 * Settle and cancel.
 *
 * Both close the trade for good, so the thing worth testing is when each is
 * offered at all: settle only once both legs are funded, and neither once the
 * trade is already over.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { testLeg, testTrade } from "./dvp.fixtures";
import { DvpCloseActions } from "./dvp-close-actions";
import type { DvpTrade, DvpTradeStatus } from "./dvp-trade";

function trade(status: DvpTradeStatus, bothFunded: boolean): DvpTrade {
  const funding = (funded: boolean) => ({
    observedAmount: funded ? "1000" : "0",
    funded,
    surplus: null,
    frozen: false,
  });
  return testTrade({
    status,
    legs: {
      a: testLeg({ funding: funding(bothFunded) }),
      b: testLeg({ funding: funding(bothFunded) }),
    },
  });
}

function renderActions(value: DvpTrade): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpCloseActions onAct={vi.fn()} pending={null} trade={value} />
    </I18nProvider>
  );
}

describe("DvpCloseActions", () => {
  it("offers both actions on a funded trade", () => {
    const html = renderActions(trade("funded", true));

    expect(html).toContain("Settle");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Both legs must be funded");
  });

  // Cancel stays available while settle does not: an unfunded trade is exactly
  // the one someone needs a way out of.
  it("explains why settle is unavailable while a leg is unfunded", () => {
    const html = renderActions(trade("created", false));

    expect(html).toContain("Both legs must be funded");
    expect(html).toContain("Cancel");
  });

  // A settled or cancelled trade has no account left to act on, so offering
  // either button would be offering a guaranteed failure.
  it.each(["settled", "cancelled", "rejected", "closed_unknown"] as const)(
    "renders nothing for a %s trade",
    (status) => {
      expect(renderActions(trade(status, true))).toBe("");
    }
  );

  // Expiry blocks settlement on chain but not the refund path, so cancel has
  // to survive it.
  it("still offers cancel after expiry", () => {
    const html = renderActions(trade("expired", true));

    expect(html).toContain("Cancel");
  });
});
