/**
 * The panel for trades somebody else set up that are waiting on this project.
 *
 * The load-bearing question is which leg is the reader's, because that decides
 * which escrow address they are shown — and that address is where they send
 * money. Getting it backwards would point somebody at the counterparty's escrow
 * and take a real transfer with it, so both directions are covered.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { DvpInboundPanel } from "./dvp-inbound-panel";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";

// The rows carry a funding action, which reaches for the router on mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const YOUR_ESCROW = "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y";
const THEIR_ESCROW = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";

function leg(escrow: string, overrides: Partial<DvpInboundLeg> = {}): DvpInboundLeg {
  return {
    party: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
    mint: "BgW9X4dThuRTWCAz9kkq51Xrth6TcwfwKmxzvLH3VeBK",
    amount: "250000000",
    decimals: 6,
    symbol: "DUSD",
    escrow,
    observedAmount: null,
    frozen: false,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpInboundTrade> = {}): DvpInboundTrade {
  return {
    id: "dvp_inbound_1",
    status: "created",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    yourSide: "b",
    legs: { a: leg(THEIR_ESCROW, { symbol: "ATD" }), b: leg(YOUR_ESCROW) },
    expiryTimestamp: "1900000000",
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function render(trades: DvpInboundTrade[]): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpInboundPanel trades={trades} />
    </I18nProvider>
  );
}

describe("DvpInboundPanel", () => {
  // A permanent "nothing is waiting on you" would sit on this page forever for
  // every project that never counterparties a trade, which is most of them.
  it("renders nothing when nothing is waiting", () => {
    expect(render([])).toBe("");
  });

  it("shows the escrow for the reader's own leg, not the counterparty's", () => {
    const html = render([trade({ yourSide: "b" })]);

    expect(html).toContain(YOUR_ESCROW);
  });

  // Same rule, opposite side. Reading the wrong leg would publish the other
  // party's escrow as the address to pay.
  it("follows the side when the reader holds leg A", () => {
    const html = render([
      trade({
        yourSide: "a",
        legs: { a: leg(THEIR_ESCROW, { symbol: "ATD" }), b: leg(YOUR_ESCROW) },
      }),
    ]);

    expect(html).toContain(THEIR_ESCROW);
  });

  // The reader was not in the room when these terms were written, so the page
  // has to say so where the address is, not only in a heading.
  it("warns that the terms were set by somebody else", () => {
    expect(render([trade()])).toContain("not present when these terms were set");
  });

  // Offering an address to pay after it has been paid invites a second transfer,
  // and a surplus can revert the settlement it was meant to complete.
  it("withdraws the address once the reader's leg is funded", () => {
    const html = render([
      trade({
        legs: {
          a: leg(THEIR_ESCROW, { symbol: "ATD" }),
          b: leg(YOUR_ESCROW, { observedAmount: "250000000" }),
        },
      }),
    ]);

    expect(html).not.toContain(YOUR_ESCROW);
    expect(html).toContain("Funded");
  });

  // A transfer into a frozen escrow bounces, so this has to be readable before
  // the address is copied rather than after the money has gone.
  it("says an escrow is frozen before offering its address", () => {
    const html = render([
      trade({
        legs: {
          a: leg(THEIR_ESCROW, { symbol: "ATD" }),
          b: leg(YOUR_ESCROW, { frozen: true }),
        },
      }),
    ]);

    expect(html).toContain("transfers in will bounce");
    expect(html.indexOf("transfers in will bounce")).toBeLessThan(html.indexOf(YOUR_ESCROW));
  });

  it("shows what the reader gets back", () => {
    const html = render([trade()]);

    expect(html).toContain("ATD");
    expect(html).toContain("DUSD");
  });
});
