/**
 * The trades list.
 *
 * Two things here are easy to get wrong and expensive when wrong: an error must
 * never render as an empty list, because "we could not read this" and "you have
 * none" are opposite claims; and a leg that has never been read must not show
 * as a zero balance. Parties render per the wire's classification: a
 * counterparty is a link, a custodied address is marked yours.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OTHER_ADDRESS, OWN_ADDRESS, THIRD_ADDRESS, testLeg, testTrade } from "./dvp.fixtures";
import type { DvpTrade } from "./dvp-trade";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return testTrade(overrides);
}

function renderList(trades: DvpTrade[], error: string | null = null): string {
  return renderWorkspace({ trades, error, inbound: [] });
}

function renderWorkspace({
  trades,
  inbound,
  error = null,
}: {
  trades: DvpTrade[];
  inbound: DvpInboundTrade[];
  error?: string | null;
}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradesWorkspace error={error} inbound={inbound} trades={trades} />
    </I18nProvider>
  );
}

/** A trade another organization set up that names one of this project's wallets. */
function inboundTrade(): DvpInboundTrade {
  const leg: DvpInboundLeg = {
    party: {
      address: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
      counterparty: null,
      custodied: true,
    },
    mint: "BgW9X4dThuRTWCAz9kkq51Xrth6TcwfwKmxzvLH3VeBK",
    amount: "250000000",
    decimals: 6,
    symbol: "DUSD",
    escrow: "BjmS3uaKPVzUmJ41t54Kgw8hVF7e8mrMFmj8Zgxqg5xJ",
    observedAmount: null,
    frozen: false,
  };
  return {
    id: "dvp_inbound_probe",
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    yourSide: "b",
    legs: { a: { ...leg, symbol: "ATD" }, b: leg },
    expiryTimestamp: "1900000000",
    createdAt: "2026-09-07T00:00:00.000Z",
  };
}

describe("DvpTradesWorkspace", () => {
  // The segment is the only thing telling a reader something is waiting on
  // them, and it carries the count. It renders only when there IS something,
  // so an empty project never grows a dead control.
  it("offers a waiting segment carrying the count when trades are inbound", () => {
    const html = renderWorkspace({
      trades: [],
      inbound: [inboundTrade()],
    });

    expect(html).toContain("Waiting on you");
    expect(html).toContain("1");
  });

  it("offers no waiting segment when nothing is inbound", () => {
    expect(renderWorkspace({ trades: [], inbound: [] })).not.toContain("Waiting on you");
  });

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

  // The filter bar earns its space only when there is something to sift; and
  // once it is there, "2 of 2" beside an untouched filter is a number that
  // answers nothing.
  it("does not show a filter bar over a single trade", () => {
    expect(renderList([trade()])).not.toContain("Search trades");
  });

  it("offers filters once there is more than one trade", () => {
    expect(renderList([trade(), trade({ id: "dvp_2" })])).toContain("Search trades");
  });

  // Four short labels behind a chevron is a dropdown charging you a click to
  // read what it could have shown.
  it("shows every status choice rather than hiding them in a dropdown", () => {
    const html = renderList([trade(), trade({ id: "dvp_2" })]);

    for (const label of ["All", "Awaiting funding", "Ready to settle", "Finished"]) {
      expect(html).toContain(label);
    }
  });

  // A finished trade's escrows are closed and empty, so the stored reading is a
  // leftover from before settlement. Rendering it as observed-over-target
  // claimed a balance that no longer exists — and a trade settled before any
  // reading was taken showed a bare number, so two finished trades rendered
  // two different ways.
  it("shows what a finished trade delivered, not a funding fraction", () => {
    const funded = testLeg({
      funding: { funded: true, observedAmount: "1000000000", frozen: false, surplus: null },
    });
    const html = renderList([trade({ status: "settled", legs: { a: funded, b: funded } })]);

    expect(html).not.toContain("/ 1,000");
  });

  /**
   * A row where you delivered the cash and a row where you delivered the asset
   * rendered identically: the columns name the legs — Asset leg, Cash leg — and
   * never say who gave what. Two rows meaning opposite things looked the same.
   */
  describe("which side you were on", () => {
    it("says you delivered the asset leg when that side is custodied", () => {
      const html = renderList([
        trade({
          status: "settled",
          legs: {
            a: testLeg({ party: { address: OWN_ADDRESS, counterparty: null, custodied: true } }),
            b: testLeg(),
          },
        }),
      ]);

      expect(html).toContain("You delivered");
      expect(html).toContain("You received");
    });

    it("says the same for a trade where the caller holds the cash leg", () => {
      const html = renderList([
        trade({
          status: "settled",
          legs: {
            a: testLeg(),
            b: testLeg({ party: { address: OWN_ADDRESS, counterparty: null, custodied: true } }),
          },
        }),
      ]);

      expect(html).toContain("You delivered");
      expect(html).toContain("You received");
    });

    // Both legs custodied is a bilateral trade: two deliveries, no receipt.
    it("says you delivered both legs on a bilateral trade", () => {
      const html = renderList([
        trade({
          kind: "bilateral",
          status: "settled",
          legs: {
            a: testLeg({ party: { address: OWN_ADDRESS, counterparty: null, custodied: true } }),
            b: testLeg({ party: { address: OWN_ADDRESS, counterparty: null, custodied: true } }),
          },
        }),
      ]);

      expect(html).toContain("You delivered");
      expect(html).not.toContain("You received");
    });
  });

  it("links a registered counterparty in the parties column to its page", () => {
    const html = renderList([
      trade({
        legs: {
          a: testLeg({
            party: {
              address: OTHER_ADDRESS,
              counterparty: { id: "cpa_1", label: "Acme OTC" },
              custodied: false,
            },
          }),
          b: testLeg({ party: { address: THIRD_ADDRESS, counterparty: null, custodied: false } }),
        },
      }),
    ]);

    expect(html).toContain("Acme OTC");
    expect(html).toContain("/dashboard/payments/counterparty/cpa_1");
  });

  it("marks a custodied party in the parties column as yours", () => {
    const html = renderList([
      trade({
        legs: {
          a: testLeg({ party: { address: OWN_ADDRESS, counterparty: null, custodied: true } }),
          b: testLeg(),
        },
      }),
    ]);

    expect(html).toContain("Yours");
    expect(html).toContain(OWN_ADDRESS.slice(0, 6));
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

    // In the units somebody entered, with the token named. 1000000000 base
    // units at 6 decimals is 1,000 ATD, and showing the integer is how this
    // list read for its whole life before decimals reached the payload.
    expect(html).toContain("1,000");
    expect(html).toContain("ATD");
    expect(html).not.toContain("1000000000");
  });

  it("shows observed over target once the escrow has been read", () => {
    const funded = testLeg({
      funding: { observedAmount: "400000000", funded: false, surplus: null, frozen: false },
    });
    const html = renderList([trade({ legs: { a: funded, b: testLeg() } })]);

    expect(html).toContain("400 / 1,000");
  });

  // Marked on the row rather than announced in a banner: a warning that does
  // not say WHICH trade sends an operator through every row to find it.
  //
  // The label is the only thing a screen reader gets from this icon, so it has
  // to name the condition that is actually true. Calling a frozen escrow
  // over-funded is a false statement, not a vague one.
  it("labels a frozen row as frozen, not as over-funded", () => {
    const frozen = testLeg({
      funding: { observedAmount: "1000", funded: true, surplus: null, frozen: true },
    });
    const html = renderList([trade({ legs: { a: frozen, b: testLeg() } })]);

    expect(html).toContain("Escrow is frozen");
    expect(html).not.toContain("Holds more than the trade needs");
  });

  it("labels an over-funded row as over-funded", () => {
    const surplus = testLeg({
      funding: { observedAmount: "1500", funded: true, surplus: "500", frozen: false },
    });
    const html = renderList([trade({ legs: { a: surplus, b: testLeg() } })]);

    expect(html).toContain("Holds more than the trade needs");
  });

  it("marks nothing on an ordinary row", () => {
    const funded = testLeg({
      funding: { observedAmount: "1000", funded: true, surplus: null, frozen: false },
    });
    const html = renderList([trade({ legs: { a: funded, b: funded } })]);

    expect(html).not.toContain("Escrow is frozen");
    expect(html).not.toContain("Holds more than the trade needs");
  });

  it("does not inline an escrow address into the parties column", () => {
    const html = renderList([trade()]);

    expect(html).not.toContain("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU");
  });
});
