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
import type { DvpSettlementAvailability, DvpTrade, DvpTradeStatus } from "./dvp-trade";
import type { DvpPendingAction } from "./use-dvp-trade-actions";

/**
 * A trade as the API answers for it: the availability is the server's,
 * judged by the cluster clock, and follows from the status the way it would.
 */
function trade(
  status: DvpTradeStatus,
  bothFunded: boolean,
  settlementAvailability: DvpSettlementAvailability | null = availabilityFor(status)
): DvpTrade {
  const funding = (funded: boolean) => ({
    observedAmount: funded ? "1000" : "0",
    funded,
    surplus: null,
    frozen: false,
  });
  return testTrade({
    status,
    settlementAvailability,
    legs: {
      a: testLeg({ funding: funding(bothFunded) }),
      b: testLeg({ funding: funding(bothFunded) }),
    },
  });
}

function availabilityFor(status: DvpTradeStatus): DvpSettlementAvailability | null {
  switch (status) {
    case "funded":
      return "available";
    case "created":
    case "partially_funded":
      return "unfunded";
    case "expired":
      return "expired";
    default:
      return null;
  }
}

function renderActions(
  value: DvpTrade,
  pending: ReadonlySet<DvpPendingAction> = new Set()
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpCloseActions onAct={vi.fn()} pending={pending} trade={value} />
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

  // Settle can never go out again past expiry. A disabled panel saying "both
  // legs must be funded" was false for a funded trade and offered nothing.
  // Expiry blocks settlement on chain but not the refund path, so cancel stays.
  it.each([
    ["an expired trade", trade("expired", true)],
    // The row can still say funded for a few seconds after expiry; the API's
    // availability, judged by the cluster clock, already says expired.
    ["a funded trade the cluster clock has already expired", trade("funded", true, "expired")],
  ])("drops the settle panel on %s and keeps cancel", (_label, value) => {
    const html = renderActions(value);

    expect(html).not.toContain("Delivers each leg");
    expect(html).not.toContain("Both legs must be funded");
    expect(html).toContain("Cancel Trade");
  });

  // Not yet observed with a cluster clock: the window is unknown, so Settle is
  // offered but held, with no reason made up for it.
  it("holds settle without a reason while availability is unknown", () => {
    const html = renderActions(trade("funded", true, null));

    const settlePanel = html.slice(0, html.indexOf("Cancel Trade"));
    expect(settlePanel).toContain("Delivers each leg");
    expect(settlePanel).toContain('disabled=""');
    expect(html).not.toContain("Both legs must be funded");
    expect(html).not.toContain("This trade can settle from");
  });

  it("says when settlement opens on a trade with an earliest settlement time", () => {
    const html = renderActions({
      ...trade("funded", true, "too_early"),
      earliestSettlementTimestamp: "1800003600",
    });

    expect(html).toContain("This trade can settle from");
    expect(html).not.toContain("Both legs must be funded");
  });

  // The page refreshes every few seconds, so a settle started just before expiry
  // can re-render as expired while it is still confirming.
  it("keeps the settle panel and its spinner while a settle confirms past expiry", () => {
    const html = renderActions(trade("expired", true), new Set(["settle"]));

    expect(html).toContain("Settling…");
  });

  // The close waits for confirmation, up to 15 seconds. A greyed-out button
  // alone read as nothing happening.
  it.each([
    ["settle", "Settling…"],
    ["cancel", "Cancelling…"],
  ] as const)("names the %s in flight on its button", (action, label) => {
    const html = renderActions(trade("funded", true), new Set([action]));

    expect(html).toContain(label);
    expect(html).toContain("animate-spin");
  });
});
