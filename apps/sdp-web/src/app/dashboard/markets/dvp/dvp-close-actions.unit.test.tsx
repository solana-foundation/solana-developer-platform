/**
 * Settle and cancel.
 *
 * Both close the trade for good, so the thing worth testing is when each is
 * offered at all: settle only once both legs are funded, and neither once the
 * trade is already over.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { testLeg, testTrade } from "./dvp.fixtures";
import { DvpCloseActions } from "./dvp-close-actions";
import type { DvpTrade, DvpTradeStatus } from "./dvp-trade";
import type { DvpPendingAction } from "./use-dvp-trade-actions";

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

/** Inside the fixture's window: its expiry is 1_900_000_000. */
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

describe("DvpCloseActions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  // Settle can never go out again past expiry. A disabled panel saying "both
  // legs must be funded" was false for a funded trade and offered nothing.
  it.each([
    ["an expired trade", trade("expired", true)],
    [
      "a funded trade whose expiry passed before the next reading",
      { ...trade("funded", true), expiryTimestamp: String(NOW_SECONDS - 1) },
    ],
  ])("drops the settle panel on %s and keeps cancel", (_label, value) => {
    const html = renderActions(value);

    expect(html).not.toContain("Delivers each leg");
    expect(html).not.toContain("Both legs must be funded");
    expect(html).toContain("Cancel Trade");
  });

  it("says when settlement opens on a trade with an earliest settlement time", () => {
    const html = renderActions({
      ...trade("funded", true),
      earliestSettlementTimestamp: String(NOW_SECONDS + 3600),
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
