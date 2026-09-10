/**
 * The trade detail page.
 *
 * The load-bearing question is which legs are the caller's, answered by the
 * wire's per-leg `wallet` — funding is offered on every custodied side (both
 * on a bilateral trade), and on no other. The fund action points at the unified
 * endpoint with the side, so each card's button names its own leg.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  LEG_ESCROW_A,
  LEG_ESCROW_B,
  OTHER_ADDRESS,
  ownParty,
  THIRD_ADDRESS,
  testLeg,
  testTrade,
} from "./dvp.fixtures";
import type { DvpTrade } from "./dvp-trade";
import { DvpTradeDetailWorkspace } from "./dvp-trade-detail-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return testTrade(overrides);
}

const FUNDED = { observedAmount: "1000", funded: true, surplus: null, frozen: false };

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

    expect(html).toContain(LEG_ESCROW_A);
    expect(html).toContain(LEG_ESCROW_B);
  });

  it("renders the derived kind where the old trade kind badge sat", () => {
    const html = renderDetail(trade({ kind: "bilateral" }));

    expect(html).toContain("Both legs are yours");
  });

  // Position, not count: what matters is that the control falls inside the card
  // for OUR escrow and before the counterparty's.
  it("attaches funding to the leg the caller custodies", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    const fundAt = html.indexOf("Fund this leg");
    expect(fundAt).toBeGreaterThan(html.indexOf(LEG_ESCROW_A));
    expect(fundAt).toBeLessThan(html.indexOf(LEG_ESCROW_B));
  });

  // Same rule, opposite side. Reading the wrong leg would offer to spend a
  // wallet this platform does not control.
  it("attaches funding to leg B when that is the custodied side", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({ escrow: LEG_ESCROW_A }),
          b: testLeg({
            escrow: LEG_ESCROW_B,
            party: ownParty(),
          }),
        },
      })
    );

    expect(html.indexOf("Fund this leg")).toBeGreaterThan(html.indexOf(LEG_ESCROW_B));
  });

  // A bilateral trade is two custodied legs: each card funds its own side
  // through the unified endpoint.
  it("offers a fund action on BOTH legs of a bilateral trade", () => {
    const html = renderDetail(
      trade({
        kind: "bilateral",
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            party: ownParty(),
          }),
          b: testLeg({
            escrow: LEG_ESCROW_B,
            party: ownParty(),
          }),
        },
      })
    );

    expect(html.indexOf("Fund this leg")).toBeGreaterThan(html.indexOf(LEG_ESCROW_A));
    expect(html.lastIndexOf("Fund this leg")).toBeGreaterThan(html.indexOf(LEG_ESCROW_B));
    expect(html.match(/Fund this leg/g)?.length).toBe(2);
  });

  /** Agent trades: the caller set the terms and holds neither leg. */
  describe("agent trades", () => {
    const agent = () => trade({ kind: "agent" });

    it("offers no funding action, because neither leg is ours to fund", () => {
      expect(renderDetail(agent())).not.toContain("Fund this leg");
    });

    it("still publishes both escrow addresses, which are the whole integration", () => {
      const html = renderDetail(agent());

      expect(html).toContain(LEG_ESCROW_A);
      expect(html).toContain(LEG_ESCROW_B);
    });

    it("captions the legs by party rather than claiming one is held here", () => {
      const html = renderDetail(agent());

      expect(html).toContain("First party");
      expect(html).toContain("Second party");
    });

    it("does not say you deliver or receive anything", () => {
      const html = renderDetail(agent());

      expect(html).not.toContain("You deliver");
      expect(html).not.toContain("You receive");
    });

    // Settling is the one thing an agent DOES do, so it must not be removed
    // along with the funding affordance.
    it("keeps the close actions, which are the agent's whole job", () => {
      const html = renderDetail(
        trade({
          kind: "agent",
          status: "funded",
          legs: {
            a: testLeg({ escrow: LEG_ESCROW_A, funding: FUNDED }),
            b: testLeg({ escrow: LEG_ESCROW_B, funding: FUNDED }),
          },
        })
      );

      expect(html).toContain("Settle");
    });
  });

  /**
   * A PARTY reading a trade another organization created.
   *
   * The same row is an agent trade to its author and a leg you owe to the party
   * named on it. `yourSide` marks the party read; the custodied leg carries the
   * fund action.
   */
  describe("viewed by a party, not the author", () => {
    const asParty = () =>
      trade({
        kind: "agent",
        yourSide: "b",
        legs: {
          a: testLeg({ escrow: LEG_ESCROW_A }),
          b: testLeg({
            escrow: LEG_ESCROW_B,
            party: ownParty(),
          }),
        },
      });

    it("offers neither settle nor cancel", () => {
      const html = renderDetail(
        trade({
          kind: "agent",
          yourSide: "b",
          status: "funded",
          legs: {
            a: testLeg({ escrow: LEG_ESCROW_A, funding: FUNDED }),
            b: testLeg({ escrow: LEG_ESCROW_B, funding: FUNDED }),
          },
        })
      );

      expect(html).not.toContain("Delivers each leg to the other party");
      expect(html).not.toContain("Refunds each leg to whoever deposited it");
    });

    it("says whose the trade is and what is not theirs to do", () => {
      expect(renderDetail(asParty())).toContain("not the settlement authority");
    });

    // Their leg, not the author's. Offering the wrong one would point a real
    // transfer at the counterparty's escrow.
    it("offers funding on the leg the party holds", () => {
      const html = renderDetail(asParty());
      const fundAt = html.indexOf("Fund this leg");

      expect(fundAt).toBeGreaterThan(-1);
      expect(fundAt).toBeGreaterThan(html.indexOf(LEG_ESCROW_B));
    });

    it("withdraws it once their own leg is funded", () => {
      const html = renderDetail(
        trade({
          kind: "agent",
          yourSide: "b",
          legs: {
            a: testLeg({ escrow: LEG_ESCROW_A }),
            b: testLeg({
              escrow: LEG_ESCROW_B,
              funding: FUNDED,
              party: ownParty(),
            }),
          },
        })
      );

      expect(html).not.toContain("Fund this leg");
    });
  });

  it("links a registered counterparty to its dashboard page", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            party: {
              address: OTHER_ADDRESS,
              counterparty: { id: "cpa_1", label: "Acme OTC" },
              wallet: null,
            },
          }),
          b: testLeg({
            escrow: LEG_ESCROW_B,
            party: { address: THIRD_ADDRESS, counterparty: null, wallet: null },
          }),
        },
      })
    );

    expect(html).toContain("Acme OTC");
    expect(html).toContain("/dashboard/payments/counterparty/cpa_1");
  });

  // A custodied party is the caller's own wallet: a link to its page, labelled
  // with its name — never plain text, per the referenced-entity house rule.
  it("links a custodied party to its wallet's page under the wallet's name", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    expect(html).toContain("/dashboard/wallets/cwlt_dvp_fixture_own");
    expect(html).toContain("Fixture Desk");
  });

  // Funding again would over-fund the escrow, and settlement refunds a surplus,
  // which on a transfer-hook mint can revert the settlement.
  it("withdraws the funding action once your leg is funded", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            funding: FUNDED,
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    expect(html).not.toContain("Fund this leg");
  });

  // A transfer into a frozen escrow bounces. Offering the button would spend a
  // signature to learn that.
  it("withdraws the funding action while your escrow is frozen", () => {
    const frozen = { observedAmount: "0", funded: false, surplus: null, frozen: true };
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            funding: frozen,
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    expect(html).not.toContain("Fund this leg");
    expect(html).toContain("Escrow is frozen");
  });

  it("warns about a surplus that settlement would have to refund", () => {
    const surplus = { observedAmount: "1500", funded: true, surplus: "500", frozen: false };
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            funding: surplus,
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

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

  it("links a funded leg's signature to the explorer per leg", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            fundingSignature:
              "2Ufq4fR5J8nYwxCzTuKw4GnxgJvjP9yWm7dQdZGpHjH6LqZ9mJf2dZrDvEg7NVpzcxKiY1T3sE5b7V9nA1C3",
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    expect(html.indexOf("Funding transaction")).toBeGreaterThan(html.indexOf(LEG_ESCROW_A));
  });
});
