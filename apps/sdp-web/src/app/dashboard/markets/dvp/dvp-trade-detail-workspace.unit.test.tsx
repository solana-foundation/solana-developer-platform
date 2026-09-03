/**
 * The trade detail page.
 *
 * The load-bearing question is which leg is yours. Funding is offered on SDP's
 * leg only: the counterparty funds theirs with an ordinary transfer, and making
 * that a button would mean spending their wallet, which is the whole thing a
 * DvP trade prevents. That mapping flips with `sdpSide`, so both directions are
 * covered.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpTrade, DvpTradeLeg, DvpTradeStatus } from "./dvp-trade";
import { DvpTradeDetailWorkspace } from "./dvp-trade-detail-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ESCROW_A = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";
const ESCROW_B = "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y";

function leg(escrow: string, overrides: Partial<DvpTradeLeg> = {}): DvpTradeLeg {
  return {
    party: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    amount: "1000",
    escrow,
    settlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    funding: null,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return {
    id: "dvp_1",
    status: "created" as DvpTradeStatus,
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: { a: leg(ESCROW_A), b: leg(ESCROW_B) },
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

function renderDetail(value: DvpTrade): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradeDetailWorkspace trade={value} />
    </I18nProvider>
  );
}

describe("DvpTradeDetailWorkspace", () => {
  // The escrow address IS the counterparty's whole integration, so it has to be
  // on the page for both legs.
  it("publishes an escrow address for each leg", () => {
    const html = renderDetail(trade());

    expect(html).toContain(ESCROW_A);
    expect(html).toContain(ESCROW_B);
  });

  // Position, not count: the hold-to-confirm control renders its label more
  // than once, so what matters is that the control falls inside the card for
  // OUR escrow and before the counterparty's.
  it("attaches funding to the leg this organization holds", () => {
    const html = renderDetail(trade());

    const fundAt = html.indexOf("Fund this leg");
    expect(fundAt).toBeGreaterThan(html.indexOf(ESCROW_A));
    expect(fundAt).toBeLessThan(html.indexOf(ESCROW_B));
  });

  // Same rule, opposite side. Reading the wrong leg would offer to spend a
  // wallet this platform does not control.
  it("attaches funding to leg B when that is the side this organization holds", () => {
    const html = renderDetail(trade({ sdpSide: "b" }));

    expect(html.indexOf("Fund this leg")).toBeGreaterThan(html.indexOf(ESCROW_B));
  });

  // Funding again would over-fund the escrow, and settlement refunds a surplus,
  // which on a transfer-hook mint can revert the settlement.
  it("withdraws the funding action once your leg is funded", () => {
    const funded = leg(ESCROW_A, {
      funding: { observedAmount: "1000", funded: true, surplus: null, frozen: false },
    });
    const html = renderDetail(trade({ legs: { a: funded, b: leg(ESCROW_B) } }));

    expect(html).not.toContain("Fund this leg");
  });

  // A transfer into a frozen escrow bounces. Offering the button would spend a
  // signature to learn that.
  it("withdraws the funding action while your escrow is frozen", () => {
    const frozen = leg(ESCROW_A, {
      funding: { observedAmount: "0", funded: false, surplus: null, frozen: true },
    });
    const html = renderDetail(trade({ legs: { a: frozen, b: leg(ESCROW_B) } }));

    expect(html).not.toContain("Fund this leg");
    expect(html).toContain("Escrow is frozen");
  });

  it("warns about a surplus that settlement would have to refund", () => {
    const surplus = leg(ESCROW_A, {
      funding: { observedAmount: "1500", funded: true, surplus: "500", frozen: false },
    });
    const html = renderDetail(trade({ legs: { a: surplus, b: leg(ESCROW_B) } }));

    expect(html).toContain("Holds more than the trade needs");
  });

  // The settlement authority is part of the trade's on-chain address, so it
  // cannot be changed and is worth showing.
  it("shows the settlement authority", () => {
    const html = renderDetail(trade());

    expect(html).toContain("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY");
  });

  // The program emits no events, so a status is a reading taken at a moment in
  // time. Saying "never checked" beats implying a fresh zero.
  it("says when nothing has read the trade yet", () => {
    const html = renderDetail(trade());

    expect(html).toContain("Never checked");
  });

  it("offers no actions on a settled trade", () => {
    const html = renderDetail(trade({ status: "settled" }));

    expect(html).not.toContain("Fund this leg");
    expect(html).not.toContain("Both legs must be funded");
  });
});
