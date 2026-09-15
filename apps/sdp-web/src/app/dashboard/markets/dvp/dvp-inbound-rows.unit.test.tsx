/**
 * Rows for trades another organization set up that name this project.
 *
 * The load-bearing question is which leg is the reader's, because that decides
 * which escrow address is shown — and that address is where they send money.
 * Getting it backwards would publish the counterparty's escrow as the one to
 * pay and take a real transfer with it, so both directions are covered.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Table, TableBody } from "@/components/ui/table";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { InboundRows } from "./dvp-inbound-rows";
import type { DvpInboundLeg, DvpInboundTrade } from "./dvp-trades.data";

// Each row owns a funding action, which reaches for the router on mount.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const YOUR_ESCROW = "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y";
const THEIR_ESCROW = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";

function leg(escrow: string, overrides: Partial<DvpInboundLeg> = {}): DvpInboundLeg {
  return {
    party: {
      address: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
      counterparty: null,
      wallet: null,
    },
    mint: "BgW9X4dThuRTWCAz9kkq51Xrth6TcwfwKmxzvLH3VeBK",
    amount: "250000000",
    decimals: 6,
    symbol: "DUSD",
    name: "Digital USD",
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
    legs: {
      a: leg(THEIR_ESCROW, { symbol: "ATD" }),
      b: leg(YOUR_ESCROW, {
        party: {
          address: "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk",
          counterparty: null,
          wallet: { id: "cwlt_dvp_inbound", name: null },
        },
      }),
    },
    expiryTimestamp: "1900000000",
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function render(trades: DvpInboundTrade[]): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <Table>
        <TableBody>
          <InboundRows trades={trades} />
        </TableBody>
      </Table>
    </I18nProvider>
  );
}

describe("InboundRows", () => {
  it("shows the escrow for the reader's own leg, not the counterparty's", () => {
    expect(render([trade({ yourSide: "b" })])).toContain(YOUR_ESCROW);
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

  it("offers the funding action while the leg is owed", () => {
    expect(render([trade()])).toContain("Fund your leg");
  });

  // Offering it again after payment invites a second transfer, and a surplus
  // can revert the settlement it was meant to complete.
  it("withdraws the action once the reader's leg is funded", () => {
    const html = render([
      trade({
        legs: {
          a: leg(THEIR_ESCROW, { symbol: "ATD" }),
          b: leg(YOUR_ESCROW, { observedAmount: "250000000" }),
        },
      }),
    ]);

    expect(html).toContain("Funded");
    expect(html).not.toContain("Fund your leg");
  });

  // A transfer into a frozen escrow bounces, so the button must not invite one.
  it("disables funding into a frozen escrow", () => {
    const html = render([
      trade({
        legs: {
          a: leg(THEIR_ESCROW, { symbol: "ATD" }),
          b: leg(YOUR_ESCROW, { frozen: true }),
        },
      }),
    ]);

    expect(html).toContain("disabled");
  });

  it("labels which leg the reader gives and which they get", () => {
    const html = render([trade()]);

    expect(html).toContain("You deliver");
    expect(html).toContain("You receive");
  });
});
