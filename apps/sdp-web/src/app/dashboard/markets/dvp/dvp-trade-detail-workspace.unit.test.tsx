// @vitest-environment jsdom
/**
 * The trade detail page.
 *
 * The load-bearing question is which legs are the caller's, answered by the
 * wire's per-leg `wallet` — funding is offered on every custodied side (both
 * on a bilateral trade), and on no other. The fund action points at the unified
 * endpoint with the side, so each card's button names its own leg.
 */

import { fireEvent, render, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The on-chain details slide open through HeightReveal, which measures itself
// with a ResizeObserver jsdom does not ship.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  }
);
afterEach(() => {
  document.body.innerHTML = "";
});

/** The page with the on-chain details opened, as text. */
function renderDetailWithOnChainOpen(value: DvpTrade): string {
  const { container } = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradeDetailWorkspace cluster="devnet" trade={value} />
    </I18nProvider>
  );
  fireEvent.click(within(container).getByRole("button", { name: "On-chain details" }));
  return container.textContent;
}

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
  // reachable for both legs: behind the on-chain details, one click away.
  it("publishes an escrow address for each leg in the on-chain details", () => {
    const text = renderDetailWithOnChainOpen(trade());

    expect(text).toContain(LEG_ESCROW_A);
    expect(text).toContain(LEG_ESCROW_B);
  });

  // Position, not count: what matters is that the control falls inside OUR
  // leg's card, which renders first, and before the counterparty's.
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

    const fundAt = html.indexOf(">Fund<");
    expect(fundAt).toBeGreaterThan(html.indexOf("Asset leg"));
    expect(fundAt).toBeLessThan(html.indexOf("Cash leg"));
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

    const fundAt = html.indexOf(">Fund<");
    expect(fundAt).toBeGreaterThan(html.indexOf("Cash leg"));
    expect(fundAt).toBeLessThan(html.indexOf("Asset leg"));
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

    expect(html.indexOf(">Fund<")).toBeGreaterThan(html.indexOf("Asset leg"));
    expect(html.lastIndexOf(">Fund<")).toBeGreaterThan(html.indexOf("Cash leg"));
    expect(html.match(/>Fund</g)?.length).toBe(2);
  });

  /** Agent trades: the caller set the terms and holds neither leg. */
  describe("agent trades", () => {
    const agent = () => trade({ kind: "agent" });

    it("offers no funding action, because neither leg is ours to fund", () => {
      expect(renderDetail(agent())).not.toContain(">Fund<");
    });

    it("still publishes both escrow addresses, which are the whole integration", () => {
      const text = renderDetailWithOnChainOpen(agent());

      expect(text).toContain(LEG_ESCROW_A);
      expect(text).toContain(LEG_ESCROW_B);
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
      const fundAt = html.indexOf(">Fund<");

      expect(fundAt).toBeGreaterThan(-1);
      expect(fundAt).toBeGreaterThan(html.indexOf("Cash leg"));
      expect(fundAt).toBeLessThan(html.indexOf("Asset leg"));
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

      expect(html).not.toContain(">Fund<");
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

    expect(html).not.toContain(">Fund<");
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
            outcome: "frozen",
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    expect(html).not.toContain(">Fund<");
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

    expect(html).toContain("Overfunded");
  });

  it("shows the reference in the on-chain details only when the trade carries one", () => {
    expect(renderDetailWithOnChainOpen(trade({ refString: "INV-2026-0042" }))).toContain(
      "INV-2026-0042"
    );
    expect(renderDetailWithOnChainOpen(trade({ refString: null }))).not.toContain("Your reference");
  });

  // A cancelled trade refunded its deposits; showing "Delivered" with a full
  // bar would misstate the financial outcome of a trade that delivered nothing.
  it("shows refunds, not delivery, on a cancelled trade", () => {
    const html = renderDetail(
      trade({
        status: "cancelled",
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            funding: FUNDED,
            outcome: "refunded",
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B, outcome: "refunded" }),
        },
      })
    );

    expect(html).toContain("Refunded to depositor");
    expect(html).toContain("Deposits returned");
    expect(html).not.toContain("Delivered");
    expect(html).not.toContain(LEG_ESCROW_B);
  });

  // Expired is not closed: the escrow still holds the deposit until a cancel
  // returns it, so the leg shows what it holds, says why it is waiting, and
  // stops offering the pay-in address.
  it("shows held deposits awaiting refund on an expired trade", () => {
    const html = renderDetail(
      trade({
        status: "expired",
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            funding: FUNDED,
            outcome: "expired",
            party: ownParty(),
          }),
          b: testLeg({ escrow: LEG_ESCROW_B, outcome: "expired" }),
        },
      })
    );

    expect(html).toContain("Expired, deposits await refund");
    expect(html).not.toContain("Delivered");
    expect(html).not.toContain(LEG_ESCROW_B);
  });

  it("shows delivery only on a settled trade", () => {
    const html = renderDetail(
      trade({
        status: "settled",
        legs: { a: testLeg({ outcome: "delivered" }), b: testLeg({ outcome: "delivered" }) },
      })
    );

    expect(html).toContain("Delivered in full");
    expect(html).not.toContain("Refunded");
  });

  it("shows a reclaimed deposit from the server outcome", () => {
    expect(
      renderDetail(trade({ legs: { a: testLeg({ outcome: "reclaimed" }), b: testLeg() } }))
    ).toContain("Deposit reclaimed by the depositor");
  });

  it("shows a late deposit that needs recovery", () => {
    expect(
      renderDetail(trade({ legs: { a: testLeg({ outcome: "recoverable" }), b: testLeg() } }))
    ).toContain("Deposit arrived after close, needs recovery");
  });

  // A frozen escrow bounces incoming transfers, so the pay-in address must not
  // be offered even though the leg is not yet funded.
  it("withdraws the deposit address while the escrow is frozen", () => {
    const frozen = { observedAmount: "0", funded: false, surplus: null, frozen: true };
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({ escrow: LEG_ESCROW_A, funding: frozen, outcome: "frozen" }),
          b: testLeg({ escrow: LEG_ESCROW_B }),
        },
      })
    );

    // The details table is collapsed, so an escrow address on the page can only
    // come from a leg card's deposit strip: B's is offered, frozen A's is not.
    expect(html).not.toContain(LEG_ESCROW_A);
    expect(html).toContain(LEG_ESCROW_B);
  });

  it("offers no actions on a settled trade", () => {
    const html = renderDetail(trade({ status: "settled" }));

    expect(html).not.toContain(">Fund<");
    expect(html).not.toContain("Both legs must be funded");
  });

  // The API resolves the mint's image when this organization issued it; a
  // foreign mint has no image and the letter mark stands in.
  it("renders the mint's image on a leg that has one, the letter mark otherwise", () => {
    const html = renderDetail(
      trade({
        legs: {
          a: testLeg({
            escrow: LEG_ESCROW_A,
            imageUrl: "https://cdn.example.test/atd.png",
          }),
          b: testLeg({ escrow: LEG_ESCROW_B, imageUrl: null }),
        },
      })
    );

    expect(html).toContain('src="https://cdn.example.test/atd.png"');
    // The fixture symbol "ATD" is short enough to be the monogram itself.
    expect(html).toContain(">ATD</span>");
  });

  it("shows a distinct token name and omits absent or symbol-identical names", () => {
    const named = renderDetail(
      trade({
        legs: {
          a: testLeg({ name: "Circle Reserve Fund" }),
          b: testLeg({ name: null, symbol: "DUSD" }),
        },
      })
    );
    const identical = renderDetail(
      trade({ legs: { a: testLeg({ name: "ATD", symbol: "ATD" }), b: testLeg({ name: null }) } })
    );

    expect(named).toContain('<p class="mt-1 text-secondary text-sm">Circle Reserve Fund</p>');
    expect(named).not.toContain('<p class="mt-1 text-secondary text-sm">DUSD</p>');
    expect(named).not.toContain('<p class="mt-1 text-secondary text-sm">ATD</p>');
    expect(identical).not.toContain('<p class="mt-1 text-secondary text-sm">ATD</p>');
  });
});
