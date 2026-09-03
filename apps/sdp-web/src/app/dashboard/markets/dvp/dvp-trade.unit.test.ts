import { describe, expect, it } from "vitest";
import {
  canCancelDvpTrade,
  canSettleDvpTrade,
  type DvpTrade,
  type DvpTradeLeg,
  frozenLegs,
  legFundingRatio,
  overFundedLegs,
} from "./dvp-trade";

function leg(overrides: Partial<DvpTradeLeg> = {}): DvpTradeLeg {
  return {
    party: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amount: "1000",
    escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    settlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    funding: null,
    ...overrides,
  };
}

function trade(overrides: Partial<DvpTrade> = {}): DvpTrade {
  return {
    id: "dvp_1",
    status: "funded",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: { a: leg(), b: leg({ amount: "2000" }) },
    sdpSide: "a",
    nonce: "42",
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    refString: null,
    createSignature: null,
    observedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("legFundingRatio", () => {
  // Null is not zero. A bar at 0% asserts nobody has paid; null says nothing
  // has looked, and those call for different words on screen.
  it("is null before anything has been observed", () => {
    expect(legFundingRatio(leg())).toBeNull();
  });

  it("is a fraction of the target while short", () => {
    const ratio = legFundingRatio(
      leg({ funding: { observedAmount: "250", funded: false, surplus: null, frozen: false } })
    );
    expect(ratio).toBeCloseTo(0.25, 4);
  });

  // An over-funded leg is fully funded plus a separate warning. A bar running
  // past its track would read as "more progress" rather than "a risk".
  it("caps at 1 for an over-funded leg", () => {
    expect(
      legFundingRatio(
        leg({
          funding: {
            observedAmount: "1000000000",
            funded: true,
            surplus: "999999000",
            frozen: false,
          },
        })
      )
    ).toBe(1);
  });

  // Both sides are u64. Dividing through Number first would round away the
  // difference entirely on values this size.
  it("keeps precision on amounts above 2^53", () => {
    const ratio = legFundingRatio(
      leg({
        amount: "18446744073709551615",
        funding: {
          observedAmount: "9223372036854775807",
          funded: false,
          surplus: null,
          frozen: false,
        },
      })
    );
    expect(ratio).toBeCloseTo(0.5, 3);
  });
});

describe("trade actions", () => {
  it("allows settling only a fully funded trade", () => {
    expect(canSettleDvpTrade(trade({ status: "funded" }))).toBe(true);
    for (const status of ["created", "partially_funded", "expired"] as const) {
      expect(canSettleDvpTrade(trade({ status }))).toBe(false);
    }
  });

  // Cancel is the escape hatch. Requiring funding would make an abandoned
  // half-funded trade impossible to unwind from the dashboard.
  it("allows cancelling any open trade, funded or not", () => {
    for (const status of ["created", "partially_funded", "funded", "expired"] as const) {
      expect(canCancelDvpTrade(trade({ status }))).toBe(true);
    }
  });

  it("offers neither action on a closed trade", () => {
    for (const status of ["settled", "cancelled", "rejected", "closed_unknown"] as const) {
      expect(canCancelDvpTrade(trade({ status }))).toBe(false);
      expect(canSettleDvpTrade(trade({ status }))).toBe(false);
    }
  });
});

describe("warnings", () => {
  it("finds a leg holding more than its target", () => {
    const over = trade({
      legs: {
        a: leg({
          funding: { observedAmount: "1500", funded: true, surplus: "500", frozen: false },
        }),
        b: leg({ amount: "2000" }),
      },
    });

    expect(overFundedLegs(over)).toHaveLength(1);
    expect(frozenLegs(over)).toHaveLength(0);
  });

  it("finds a frozen escrow, which a zero balance cannot convey", () => {
    const frozen = trade({
      legs: {
        a: leg({ funding: { observedAmount: "0", funded: false, surplus: null, frozen: true } }),
        b: leg({ amount: "2000" }),
      },
    });

    expect(frozenLegs(frozen)).toHaveLength(1);
    expect(overFundedLegs(frozen)).toHaveLength(0);
  });

  it("reports nothing for a leg nothing has observed", () => {
    expect(overFundedLegs(trade())).toHaveLength(0);
    expect(frozenLegs(trade())).toHaveLength(0);
  });
});
