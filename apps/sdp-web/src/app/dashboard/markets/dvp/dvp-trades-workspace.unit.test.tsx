// @vitest-environment jsdom

/**
 * The trades list.
 *
 * Two things here are easy to get wrong and expensive when wrong: an error must
 * never render as an empty list, because "we could not read this" and "you have
 * none" are opposite claims; and a leg that has never been read must not show
 * as a zero balance. Parties render per the wire's classification: a
 * counterparty is a link, a custodied address links its wallet's page.
 *
 * The list's own status/search filtering is SERVER-SIDE now (the URL carries
 * `?status=<group>&q=<text>` and the page refetches), so the client-filter
 * assertions this file used to carry are gone; what stays here is what the
 * workspace still decides locally — the waiting segment's reachability, the
 * filter strip's presence rules, and the party/leg rendering.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  OTHER_ADDRESS,
  OWN_ADDRESS,
  OWN_WALLET_ID,
  ownParty,
  THIRD_ADDRESS,
  testLeg,
  testTrade,
} from "./dvp.fixtures";
import type { DvpTrade } from "./dvp-trade";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

const replaceMock = vi.fn();

// The workspace navigates through the router on filter changes; the render
// harness never runs effects, and the mock exists so importing the hook does
// not throw in a node environment.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

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
  statusFilter = "all",
}: {
  trades: DvpTrade[];
  inbound: DvpInboundTrade[];
  error?: string | null;
  statusFilter?: "all" | "open" | "ready" | "closed";
}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradesWorkspace
        error={error}
        inbound={inbound}
        statusFilter={statusFilter}
        trades={trades}
      />
    </I18nProvider>
  );
}

/** A trade another organization set up that names one of this project's wallets. */
function inboundTrade(): DvpInboundTrade {
  const leg: DvpInboundLeg = {
    party: {
      address: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
      counterparty: null,
      wallet: null,
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

afterEach(() => {
  replaceMock.mockClear();
});

describe("DvpTradesWorkspace", () => {
  // The status dropdown is the only path to an inbound trade, so the filter
  // strip must render even when the project has no trades of its own —
  // hiding the control hides the trade with it.
  it("offers the filter strip when trades are inbound, even with none of its own", () => {
    const html = renderWorkspace({
      trades: [],
      inbound: [inboundTrade()],
    });

    expect(html).toContain("Search trades");
    expect(html).toContain("Filter by status");
  });

  it("offers no filters when nothing is inbound and the list is empty", () => {
    expect(renderWorkspace({ trades: [], inbound: [] })).not.toContain("Filter by status");
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

  // The search is a client-side sieve: it narrows the rendered rows and never
  // writes the URL, so there is no query param to restore or race.
  it("filters the trades client-side without touching the URL", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <DvpTradesWorkspace
          error={null}
          inbound={[]}
          statusFilter="all"
          trades={[trade(), trade({ id: "dvp_2" })]}
        />
      </I18nProvider>
    );

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dvp_2" } });

    // The id is not rendered as text; the row's detail link carries it.
    expect(document.querySelector('a[href*="dvp_2"]')).toBeTruthy();
    expect(document.querySelector('a[href*="dvp_1"]')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // The trigger names what the control filters, not the opaque "All" — the
  // options themselves live in the dropdown portal and render only when open.
  it("names the status filter on its closed trigger", () => {
    expect(renderList([trade(), trade({ id: "dvp_2" })])).toContain("Filter by status");
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
            a: testLeg({ party: ownParty() }),
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
            b: testLeg({ party: ownParty() }),
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
            a: testLeg({ party: ownParty() }),
            b: testLeg({ party: ownParty() }),
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
              wallet: null,
            },
          }),
          b: testLeg({ party: { address: THIRD_ADDRESS, counterparty: null, wallet: null } }),
        },
      }),
    ]);

    expect(html).toContain("Acme OTC");
    expect(html).toContain("/dashboard/payments/counterparty/cpa_1");
  });

  // A custodied party is the caller's own wallet: a link to its page, labelled
  // with its name — never plain text, per the house rule for referenced
  // entities, and never a bare "yours" badge now that the API names the wallet.
  it("links a custodied party to its wallet's page under the wallet's name", () => {
    const html = renderList([
      trade({
        legs: {
          a: testLeg({ party: ownParty() }),
          b: testLeg(),
        },
      }),
    ]);

    expect(html).toContain(`/dashboard/wallets/${OWN_WALLET_ID}`);
    expect(html).toContain("Fixture Desk");
    expect(html).toContain(OWN_ADDRESS.slice(0, 6));
  });

  // A wallet with no display name still links; the label falls back to the
  // generic SDP Wallet copy rather than an empty string.
  it("labels an unnamed custodied wallet with the SDP Wallet fallback", () => {
    const html = renderList([
      trade({
        legs: {
          a: testLeg({ party: ownParty({ wallet: { id: OWN_WALLET_ID, name: null } }) }),
          b: testLeg(),
        },
      }),
    ]);

    expect(html).toContain(`/dashboard/wallets/${OWN_WALLET_ID}`);
    expect(html).toContain("SDP Wallet");
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
  // The label is the only thing a screen reader gets from this icon, so it
  // has to name the condition that is actually true. Calling a frozen escrow
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
