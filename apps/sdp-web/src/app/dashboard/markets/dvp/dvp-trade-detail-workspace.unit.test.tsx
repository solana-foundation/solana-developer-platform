// @vitest-environment jsdom
/**
 * The trade detail page.
 *
 * The load-bearing question is which legs are the caller's, answered by the
 * wire's per-leg `wallet` — funding is offered on every custodied side (both
 * on a bilateral trade), and on no other. The fund action points at the unified
 * endpoint with the side, so each card's button names its own leg.
 */

import { fireEvent, render, waitFor, within } from "@testing-library/react";
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
  testParty,
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
  vi.restoreAllMocks();
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

/** Each transfer row's label, in page order. */
function transferLabels(html: string): string[] {
  return [
    ...html.matchAll(/<li[^>]*><span[^>]*><span[^>]*><svg[^>]*>.*?<\/svg>([^<]+)<\/span>/g),
  ].map((match) => match[1] ?? "");
}

describe("DvpTradeDetailWorkspace", () => {
  it.each(["fund", "reclaim"] as const)(
    "shows and uses the server-selected exact wallet for %s",
    async (action) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const value = trade({
        status: action === "reclaim" ? "funded" : "created",
        legs: {
          a: testLeg({
            funding: action === "reclaim" ? FUNDED : null,
            outcome: action === "reclaim" ? "funded" : "awaiting",
            party: ownParty({
              wallet: { id: "cwlt_read", name: "Read desk" },
              actionWallet: {
                id: "cwlt_execute",
                name: "Execution desk",
                isRuntimeExecutionAllowed: true,
              },
            }),
          }),
          b: testLeg(),
        },
      });
      const { container } = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <DvpTradeDetailWorkspace cluster="devnet" trade={value} />
        </I18nProvider>
      );

      expect(
        within(container).getByRole("link", { name: "Execution desk" }).getAttribute("href")
      ).toBe("/dashboard/wallets/cwlt_execute");
      expect(container.textContent).not.toContain("Read desk");
      fireEvent.click(
        within(container).getByRole("button", { name: action === "fund" ? "Fund" : "Reclaim" })
      );

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/dashboard/markets/dvp/trades/dvp_1/${action}`,
          expect.objectContaining({ body: JSON.stringify({ side: "a", walletId: "cwlt_execute" }) })
        )
      );
    }
  );

  describe.each(["fund", "reclaim"] as const)("%s admission", (action) => {
    it.each([
      null,
      { id: "cwlt_disabled", name: "Disabled desk", isRuntimeExecutionAllowed: false },
    ])(
      "keeps the party readable but prevents signing with an unavailable action wallet: %j",
      (actionWallet) => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const value = trade({
          legs: {
            a: testLeg({
              party: ownParty({ actionWallet }),
              funding: action === "reclaim" ? FUNDED : null,
              outcome: action === "reclaim" ? "funded" : "awaiting",
            }),
            b: testLeg(),
          },
        });
        const { container } = render(
          <I18nProvider locale="en" messages={getMessages("en")}>
            <DvpTradeDetailWorkspace cluster="devnet" trade={value} />
          </I18nProvider>
        );

        const button = within(container).getByRole("button", {
          name: action === "fund" ? "Fund" : "Reclaim",
        });
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(container.textContent).toContain("Signing is disabled");
        expect(container.textContent).not.toContain("for this wallet");
        expect(
          within(container).getByRole("link", { name: actionWallet?.name ?? "Fixture Desk" })
        ).toBeTruthy();
        fireEvent.click(button);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );
  });

  // The escrow address IS the counterparty's whole integration, so it has to be
  // reachable for both legs: behind the on-chain details, one click away.
  it("publishes an escrow address for each leg in the on-chain details", () => {
    const text = renderDetailWithOnChainOpen(trade());

    expect(text).toContain(LEG_ESCROW_A);
    expect(text).toContain(LEG_ESCROW_B);
  });

  // The settlement authority is an SDP-held key nobody picks or acts on. It
  // stays on the API response for ops, not on the page.
  it("does not list the settlement authority in the on-chain details", () => {
    const value = trade();
    const text = renderDetailWithOnChainOpen(value);

    expect(text).not.toContain("Settlement authority");
    expect(text).not.toContain(value.settlementAuthority);
  });

  // PRO-1941. The leg card lists what the escrow's own history shows, whoever
  // sent it, in place of the one transfer this organization broadcast.
  describe("escrow transfers", () => {
    const DEPOSIT = {
      signature: "sig_deposit",
      direction: "in",
      kind: "deposit",
      amount: "1000000000",
      slot: "420",
      blockTime: "2026-09-10T00:26:40.000Z",
      feePayer: OTHER_ADDRESS,
    };
    const DELIVERY = {
      ...DEPOSIT,
      signature: "sig_settle",
      direction: "out",
      kind: "delivery",
      slot: "421",
    };
    const REFUND_IN = { ...DEPOSIT, signature: "sig_redeposit", slot: "422" };

    it("starts with the latest five transfers and reveals earlier history in order", () => {
      const transfers = Array.from({ length: 12 }, (_, index) => ({
        ...DEPOSIT,
        signature: `sig_${index}`,
        slot: String(420 + index),
      }));
      const value = trade({
        status: "settled",
        legs: {
          a: testLeg({ funding: FUNDED, outcome: "delivered", transfers }),
          b: testLeg({ funding: FUNDED, outcome: "delivered" }),
        },
      });
      const { container } = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <DvpTradeDetailWorkspace cluster="devnet" trade={value} />
        </I18nProvider>
      );
      const page = within(container);
      const links = () => page.getAllByRole("link", { name: "View transaction" });
      expect(links()).toHaveLength(5);
      expect(links()[0].getAttribute("href")).toContain("tx/sig_7?");
      fireEvent.click(page.getByRole("button", { name: "Show earlier transfers (7)" }));
      expect(links()).toHaveLength(10);
      fireEvent.click(page.getByRole("button", { name: "Show earlier transfers (2)" }));
      expect(links()).toHaveLength(12);
      expect(links()[0].getAttribute("href")).toContain("tx/sig_0?");
      expect(page.queryByRole("button", { name: /Show earlier transfers/ })).toBeNull();
    });

    // The API names each movement; the card says what it was and links it.
    it("labels each movement by its kind, with each transaction linked", () => {
      const html = renderDetail(
        trade({
          status: "settled",
          legs: {
            a: testLeg({
              funding: FUNDED,
              fundingSignature: "sig_deposit",
              outcome: "delivered",
              transfers: [DEPOSIT, DELIVERY],
            }),
            b: testLeg({ funding: FUNDED, outcome: "delivered" }),
          },
        })
      );

      expect(html).toContain("Transfers");
      expect(transferLabels(html)).toEqual(["Deposit", "Delivered"]);
      expect(html).toContain("1,000 ATD");
      expect(html).toContain("tx/sig_deposit?cluster=devnet");
      expect(html).toContain("tx/sig_settle?cluster=devnet");
    });

    it("lists a reclaim between two deposits in order", () => {
      const html = renderDetail(
        trade({
          status: "funded",
          legs: {
            a: testLeg({
              funding: FUNDED,
              outcome: "funded",
              transfers: [
                DEPOSIT,
                { ...DELIVERY, signature: "sig_reclaim", kind: "reclaim" },
                REFUND_IN,
              ],
            }),
            b: testLeg({ funding: FUNDED, outcome: "funded" }),
          },
        })
      );

      expect(transferLabels(html)).toEqual(["Deposit", "Reclaimed", "Deposit"]);
    });

    // A partly paid leg still shows where to pay, with what arrived beneath it.
    it("keeps the escrow address above the deposits on a leg still receiving", () => {
      const html = renderDetail(
        trade({
          status: "partially_funded",
          legs: {
            a: testLeg({ outcome: "partial", transfers: [DEPOSIT] }),
            b: testLeg(),
          },
        })
      );

      expect(html).toContain("Funding instructions");
      expect(html.indexOf("Funding instructions")).toBeLessThan(
        html.indexOf("</svg>Deposit</span>")
      );
      expect(transferLabels(html)).toEqual(["Deposit"]);
    });

    // An answer the page cannot read is not "nothing moved": no list, and the
    // footer says what the observation says.
    it("shows no list, not an empty one, when the transfers cannot be read", () => {
      const html = renderDetail(
        trade({
          status: "funded",
          legs: {
            a: testLeg({
              funding: FUNDED,
              outcome: "funded",
              transfers: [{ ...DEPOSIT, amount: "-5" }],
            }),
            b: testLeg({ funding: FUNDED, outcome: "funded" }),
          },
        })
      );

      expect(html).not.toContain("Transfers");
      expect(transferLabels(html)).toEqual([]);
      expect(html).toContain("Sent by the counterparty");
    });
  });

  // Only the leg's own party can sign a reclaim, and only a deposit can come back.
  describe("reclaim", () => {
    const held = (amount: string) => ({
      observedAmount: amount,
      funded: amount === "1000",
      surplus: null,
      frozen: false,
    });

    // Each row is a state the API can produce: the status, and each leg's
    // funding and outcome as the server derives them for that status.
    it.each([
      ["a funded leg the caller holds", "funded", ownParty(), held("1000"), "funded", true],
      [
        "a partly funded leg the caller holds",
        "partially_funded",
        ownParty(),
        held("400"),
        "partial",
        true,
      ],
      // No expiry gate on chain, and an expired trade is where it matters most.
      [
        "an expired trade's leg the caller holds",
        "expired",
        ownParty(),
        held("1000"),
        "expired",
        true,
      ],
      ["the counterparty's leg", "funded", testParty(), held("1000"), "funded", false],
      ["an empty escrow", "created", ownParty(), held("0"), "awaiting", false],
      // The escrows are closed: no observed balance, and the leg was delivered.
      ["a settled trade", "settled", ownParty(), null, "delivered", false],
    ] as const)("on %s: offered=%s", (_label, status, party, funding, outcome, offered) => {
      const html = renderDetail(
        trade({
          status,
          legs: {
            a: testLeg({ party, funding, outcome }),
            b: testLeg({ funding, outcome }),
          },
        })
      );

      expect(html.includes(">Reclaim<")).toBe(offered);
    });
  });

  // A reclaim racing a settle can only make one of them fail, so the quiet
  // footer action waits while anything is in flight.
  it("holds Reclaim while a settle is still confirming", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));
    try {
      const { container } = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <DvpTradeDetailWorkspace
            cluster="devnet"
            trade={trade({
              status: "funded",
              settlementAvailability: "available",
              legs: {
                a: testLeg({ party: ownParty(), funding: FUNDED, outcome: "funded" }),
                b: testLeg({ funding: FUNDED, outcome: "funded" }),
              },
            })}
          />
        </I18nProvider>
      );
      const view = within(container);
      expect(view.getByRole("button", { name: "Reclaim" })).not.toHaveProperty("disabled", true);

      fireEvent.click(view.getByRole("button", { name: "Settle" }));

      expect(await view.findByRole("button", { name: "Reclaim" })).toHaveProperty("disabled", true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
  it("never claims a counterparty deposit on a leg nothing reached", () => {
    const html = renderDetail(
      trade({
        status: "expired",
        legs: {
          a: testLeg({ escrow: LEG_ESCROW_A, outcome: "expired" }),
          b: testLeg({ escrow: LEG_ESCROW_B, outcome: "expired", funding: FUNDED }),
        },
      })
    );

    expect(html).toContain("No deposit received");
    expect(html).toContain("Sent by the counterparty");
  });

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
