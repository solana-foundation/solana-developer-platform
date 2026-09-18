import { describe, expect, it } from "vitest";
import type { DvpTradeRow } from "@/db/repositories";
import { buildDvpTradeRow } from "@/test/fixtures/dvp";
import { deriveDvpLegOutcome } from "./leg-outcome";

/** A persisted trade with every address the same, which outcome derivation never reads. */
function trade(overrides: Partial<DvpTradeRow>): DvpTradeRow {
  return buildDvpTradeRow({
    id: "dvp_outcome",
    amountA: "100",
    amountB: "200",
    ...overrides,
  });
}

const IN = { direction: "in" } as const;
const OUT = { direction: "out" } as const;

const CLOSED_AND_OBSERVED = {
  closedAt: "2026-09-10T00:01:00.000Z",
  observedAt: "2026-09-10T00:01:00.000Z",
} as const satisfies Partial<DvpTradeRow>;

const CLOSED_UNOBSERVED = {
  closedAt: "2026-09-10T00:01:00.000Z",
  observedAt: "2026-09-10T00:00:00.000Z",
} as const satisfies Partial<DvpTradeRow>;

describe("deriveDvpLegOutcome", () => {
  it.each([
    ["awaiting", trade({ escrowAAmount: "0", escrowAPeakAmount: "0" })],
    ["partial", trade({ escrowAAmount: "50", escrowAPeakAmount: "50" })],
    ["funded", trade({ escrowAAmount: "100", escrowAPeakAmount: "100" })],
    ["overfunded", trade({ escrowAAmount: "101", escrowAPeakAmount: "101" })],
    ["frozen", trade({ escrowAAmount: "100", escrowAFrozen: true })],
    ["expired", trade({ status: "expired", escrowAAmount: "25", escrowAPeakAmount: "25" })],
    ["delivered", trade({ status: "settled" })],
    ["refunded", trade({ status: "rejected" })],
    [
      "recoverable",
      trade({ ...CLOSED_AND_OBSERVED, status: "closed_unknown", escrowAAmount: "1" }),
    ],
    ["closed", trade({ status: "create_failed", escrowAAmount: "0" })],
  ] as const)("derives %s", (outcome, row) => {
    expect(deriveDvpLegOutcome(row, "a", [])).toBe(outcome);
  });

  /**
   * PRO-1941. An open leg reads from its balance against its target, and reads
   * reclaimed only while the latest recorded movement took tokens out and the
   * balance is short. The peak on the row is set high on purpose in every case
   * below: it must decide nothing.
   */
  describe("an open leg, from the ledger", () => {
    const PEAK = { escrowAPeakAmount: "100" } as const;

    it.each([
      ["a leg reclaimed in full", "reclaimed", "0", [IN, OUT]],
      ["a leg reclaimed in part", "reclaimed", "40", [IN, OUT]],
      ["a reclaim refunded to the target", "funded", "100", [IN, OUT, IN]],
      ["a reclaim refunded in part", "partial", "60", [IN, OUT, IN]],
      ["a reclaim refunded past the target", "overfunded", "130", [IN, OUT, IN]],
      ["deposits in parts", "partial", "70", [IN, IN]],
      // Out of an overfunded escrow down to the target is not short of it.
      ["a surplus reclaimed down to the target", "funded", "100", [IN, IN, OUT]],
    ] as const)("reads %s as %s", (_label, outcome, balance, transfers) => {
      expect(deriveDvpLegOutcome(trade({ ...PEAK, escrowAAmount: balance }), "a", transfers)).toBe(
        outcome
      );
    });

    // The peak never saw the deposit, so the old rule read this as awaiting.
    it("reads a deposit and a reclaim between two observations as reclaimed", () => {
      expect(
        deriveDvpLegOutcome(trade({ escrowAAmount: "0", escrowAPeakAmount: "0" }), "a", [IN, OUT])
      ).toBe("reclaimed");
    });

    // Nothing recorded is no evidence that anything left: the balance is the
    // one chain fact held, so a leg below its peak is not called reclaimed.
    it.each([
      ["awaiting", "0"],
      ["partial", "25"],
      ["funded", "100"],
    ] as const)("falls back to the balance with no ledger rows yet: %s", (outcome, balance) => {
      expect(deriveDvpLegOutcome(trade({ ...PEAK, escrowAAmount: balance }), "a", [])).toBe(
        outcome
      );
    });

    it("reads a leg never observed as awaiting whatever the ledger says", () => {
      expect(deriveDvpLegOutcome(trade({ escrowAAmount: null }), "a", [IN, OUT])).toBe("awaiting");
    });

    it("keeps frozen ahead of a reclaim, and a reclaim ahead of expiry", () => {
      expect(
        deriveDvpLegOutcome(trade({ escrowAAmount: "0", escrowAFrozen: true }), "a", [IN, OUT])
      ).toBe("frozen");
      expect(
        deriveDvpLegOutcome(trade({ status: "expired", escrowAAmount: "0" }), "a", [IN, OUT])
      ).toBe("reclaimed");
    });

    it("reads each side from its own balance", () => {
      expect(
        deriveDvpLegOutcome(trade({ escrowAAmount: "0", escrowBAmount: "200" }), "b", [IN, OUT])
      ).toBe("funded");
    });
  });

  // Settle and cancel move every token out; that outflow is delivery or refund,
  // never a reclaim.
  it.each([
    ["settled", "delivered"],
    ["cancelled", "refunded"],
  ] as const)("reads the closing outflow of a %s trade as %s", (status, outcome) => {
    expect(
      deriveDvpLegOutcome(trade({ ...CLOSED_AND_OBSERVED, status, escrowAAmount: null }), "a", [
        IN,
        OUT,
      ])
    ).toBe(outcome);
  });

  // Settle, Cancel and Reject close the escrow, so a balance under any closed
  // trade is a deposit that arrived afterwards. Naming the leg delivered or
  // refunded would hide funds only RecoverDvp can move.
  it.each([
    ["settled", trade({ ...CLOSED_AND_OBSERVED, status: "settled", escrowAAmount: "1" })],
    ["cancelled", trade({ ...CLOSED_AND_OBSERVED, status: "cancelled", escrowAAmount: "1" })],
    ["rejected", trade({ ...CLOSED_AND_OBSERVED, status: "rejected", escrowAAmount: "1" })],
  ] as const)("reports a late deposit under a %s trade as recoverable", (_status, row) => {
    expect(deriveDvpLegOutcome(row, "a", [IN, OUT, IN])).toBe("recoverable");
  });

  // recordClose moves the status before the post-close reading lands, so the
  // balances still on the row were read while the trade was open.
  it.each([
    [
      "settled",
      "delivered",
      trade({ ...CLOSED_UNOBSERVED, status: "settled", escrowAAmount: "100" }),
    ],
    [
      "cancelled",
      "refunded",
      trade({ ...CLOSED_UNOBSERVED, status: "cancelled", escrowAAmount: "100" }),
    ],
  ] as const)("reads a pre-close balance under a %s trade as %s", (_status, outcome, row) => {
    expect(deriveDvpLegOutcome(row, "a", [IN])).toBe(outcome);
  });
});
