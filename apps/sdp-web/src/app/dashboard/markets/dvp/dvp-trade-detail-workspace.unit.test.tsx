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
    symbol: "ATD",
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
    closeSignature: null,
    sdpWallet: null,
    settlementReadiness: null,
    fundingSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function renderDetail(value: DvpTrade): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradeDetailWorkspace cluster="devnet" trade={value} />
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

  /**
   * Agent trades: this organization set the terms and holds neither leg.
   *
   * This page had no notion of the kind at all, so an agent trade fell through
   * every `sdpSide === "a"` check into the else branch, presented leg B as
   * ours, and offered to fund it. The API refuses that (`services/dvp/fund.ts`
   * rejects the kind, and `sdpLegOf` throws on a null side), so the button led
   * nowhere — but it contradicted the one thing an agent trade means, on the
   * screen a viewer looks at longest.
   */
  describe("agent trades", () => {
    const agent = () => trade({ tradeKind: "agent", sdpSide: null });

    it("offers no funding action, because neither leg is ours to fund", () => {
      expect(renderDetail(agent())).not.toContain("Fund this leg");
    });

    it("still publishes both escrow addresses, which are the whole integration", () => {
      const html = renderDetail(agent());

      expect(html).toContain(ESCROW_A);
      expect(html).toContain(ESCROW_B);
    });

    it("captions the legs by party rather than claiming one is held here", () => {
      const html = renderDetail(agent());

      expect(html).toContain("First party");
      expect(html).toContain("Second party");
      expect(html).not.toContain("Held by this organization");
    });

    it("does not say you deliver or receive anything", () => {
      const html = renderDetail(agent());

      expect(html).not.toContain("You deliver");
      expect(html).not.toContain("You receive");
    });

    // A trade between two other parties has no "the counterparty": naming one
    // of them as ours would put a false fact on the page.
    it("names both parties instead of a single counterparty", () => {
      const html = renderDetail(
        trade({
          tradeKind: "agent",
          sdpSide: null,
          legs: {
            a: leg(ESCROW_A, { party: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC" }),
            b: leg(ESCROW_B, { party: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk" }),
          },
        })
      );

      expect(html).toContain("AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
      expect(html).toContain("C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk");
    });

    // The kind is what the API sends; the null side is what it means. A row
    // written before the column existed carries neither, and is principal.
    it("treats a null side as an agent trade even without the kind", () => {
      expect(renderDetail(trade({ sdpSide: null }))).not.toContain("Fund this leg");
    });

    // The custody wallet row is keyed off `sdpWallet`, not the side, so
    // sweeping every `sdpSide` read did not reach it. It claimed the trade
    // "spends from it and delivers to it", which on an agent trade it does
    // neither of: it signs, and it pays the fee and the escrow rent.
    it("says what the custody wallet actually did, which is not deliver", () => {
      const html = renderDetail(
        trade({
          tradeKind: "agent",
          sdpSide: null,
          sdpWallet: { address: "4fpJcAAs1tVMgPx38XorGjBAAKqPAxwow5vHzyyETfaq", label: "mullah" },
        })
      );

      expect(html).not.toContain("This trade spends from it and delivers to it");
      expect(html).toContain("Signed and paid by");
    });

    // Settling is the one thing an agent DOES do, so it must not be removed
    // along with the funding affordance.
    it("keeps the close actions, which are the agent's whole job", () => {
      const funded = {
        a: leg(ESCROW_A, {
          funding: { observedAmount: "1000", funded: true, surplus: null, frozen: false },
        }),
        b: leg(ESCROW_B, {
          funding: { observedAmount: "1000", funded: true, surplus: null, frozen: false },
        }),
      };
      const html = renderDetail(
        trade({ tradeKind: "agent", sdpSide: null, status: "funded", legs: funded })
      );

      expect(html).toContain("Settle");
    });
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
