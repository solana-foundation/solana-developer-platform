/**
 * The trades list.
 *
 * Two things here are easy to get wrong and expensive when wrong: an error must
 * never render as an empty list, because "we could not read this" and "you have
 * none" are opposite claims; and a leg that has never been read must not show
 * as a zero balance.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpTrade, DvpTradeLeg } from "./dvp-trade";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

function leg(overrides: Partial<DvpTradeLeg> = {}): DvpTradeLeg {
  return {
    party: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    symbol: "ATD",
    amount: "1000",
    escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    settlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    funding: null,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return {
    id: "dvp_1",
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: { a: leg(), b: leg() },
    sdpSide: "a",
    nonce: "42",
    expiryTimestamp: "1900000000",
    earliestSettlementTimestamp: null,
    refString: null,
    createSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function renderList(trades: DvpTrade[], error: string | null = null): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradesWorkspace error={error} trades={trades} />
    </I18nProvider>
  );
}

describe("DvpTradesWorkspace", () => {
  it("invites a first trade when the list is genuinely empty", () => {
    const html = renderList([]);

    expect(html).toContain("No trades yet");
    expect(html).toContain("/dashboard/markets/dvp/create");
  });

  // An error and a table of nothing say opposite things. Showing both claims
  // the list is empty when the truth is that it could not be read.
  it("shows only the error when the list failed to load", () => {
    const html = renderList([], "Upstream unavailable.");

    expect(html).toContain("Upstream unavailable.");
    expect(html).not.toContain("No trades yet");
    expect(html).not.toContain("<table");
  });

  // Two identical buttons on one screen read as two different actions.
  it("does not repeat the create button beside the empty state", () => {
    expect(renderList([]).match(/dvp\/create/g)?.length).toBe(1);
  });

  it("keeps create reachable once trades exist", () => {
    const html = renderList([trade()]);

    expect(html).toContain("/dashboard/markets/dvp/create");
    expect(html).toContain("<table");
  });

  // Before anything has read the escrow, its balance is unknown rather than
  // zero, so only the target is shown.
  it("shows only the target for a leg nothing has read yet", () => {
    const html = renderList([trade()]);

    expect(html).toContain("1000");
    expect(html).not.toContain("0 / 1000");
  });

  it("shows observed over target once the escrow has been read", () => {
    const funded = leg({
      funding: { observedAmount: "400", funded: false, surplus: null, frozen: false },
    });
    const html = renderList([trade({ legs: { a: funded, b: leg() } })]);

    expect(html).toContain("400 / 1000");
  });

  // Marked on the row rather than announced in a banner: a warning that does
  // not say WHICH trade sends an operator through every row to find it.
  //
  // The label is the only thing a screen reader gets from this icon, so it has
  // to name the condition that is actually true. Calling a frozen escrow
  // over-funded is a false statement, not a vague one.
  it("labels a frozen row as frozen, not as over-funded", () => {
    const frozen = leg({
      funding: { observedAmount: "1000", funded: true, surplus: null, frozen: true },
    });
    const html = renderList([trade({ legs: { a: frozen, b: leg() } })]);

    expect(html).toContain("Escrow is frozen");
    expect(html).not.toContain("Holds more than the trade needs");
  });

  it("labels an over-funded row as over-funded", () => {
    const surplus = leg({
      funding: { observedAmount: "1500", funded: true, surplus: "500", frozen: false },
    });
    const html = renderList([trade({ legs: { a: surplus, b: leg() } })]);

    expect(html).toContain("Holds more than the trade needs");
  });

  it("marks nothing on an ordinary row", () => {
    const funded = leg({
      funding: { observedAmount: "1000", funded: true, surplus: null, frozen: false },
    });
    const html = renderList([trade({ legs: { a: funded, b: funded } })]);

    expect(html).not.toContain("Escrow is frozen");
    expect(html).not.toContain("Holds more than the trade needs");
  });
});
