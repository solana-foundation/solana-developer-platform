import { describe, expect, it } from "vitest";
import { OTHER_ADDRESS, OWN_WALLET_ID, ownParty, testLeg, testTrade } from "./dvp.fixtures";
import {
  canCancelDvpTrade,
  custodiedSidesOf,
  dvpSettleAvailability,
  frozenLegs,
  legFundingRatio,
  matchesAddressQuery,
  overFundedLegs,
} from "./dvp-trade";
import { isNotFound } from "./dvp-trades.data";

function trade(overrides: Parameters<typeof testTrade>[0] = {}): ReturnType<typeof testTrade> {
  return testTrade({ status: "funded", ...overrides });
}

describe("legFundingRatio", () => {
  // Null is not zero. A bar at 0% asserts nobody has paid; null says nothing
  // has looked, and those call for different words on screen.
  it("is null before anything has been observed", () => {
    expect(legFundingRatio(testLeg())).toBeNull();
  });

  it("is a fraction of the target while short", () => {
    const ratio = legFundingRatio(
      testLeg({
        funding: { observedAmount: "250000000", funded: false, surplus: null, frozen: false },
      })
    );
    expect(ratio).toBeCloseTo(0.25, 4);
  });

  // An over-funded leg is fully funded plus a separate warning. A bar running
  // past its track would read as "more progress" rather than "a risk".
  it("caps at 1 for an over-funded leg", () => {
    expect(
      legFundingRatio(
        testLeg({
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
      testLeg({
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

/** Inside the fixture's window: its expiry is 1_900_000_000. */
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

describe("trade actions", () => {
  it("allows settling only a fully funded trade", () => {
    expect(dvpSettleAvailability(trade({ status: "funded" }), NOW_MS)).toBe("available");
    for (const status of ["created", "partially_funded", "expired"] as const) {
      expect(dvpSettleAvailability(trade({ status }), NOW_MS)).not.toBe("available");
    }
  });

  // The status trails the chain by one reading, so a trade that expired a
  // moment ago can still say funded. The program refuses it either way.
  it("reads a funded trade past its expiry as expired, not settleable", () => {
    const expired = trade({ status: "funded", expiryTimestamp: String(NOW_SECONDS - 1) });

    expect(dvpSettleAvailability(expired, NOW_MS)).toBe("expired");
  });

  // `settle_dvp.rs` checks `now <= expiry`, so the expiry second itself settles.
  it("still settles during the exact expiry second", () => {
    const edge = trade({ status: "funded", expiryTimestamp: String(NOW_SECONDS) });

    expect(dvpSettleAvailability(edge, NOW_MS + 999)).toBe("available");
  });

  it("names an earliest settlement time that has not arrived yet", () => {
    const early = trade({ status: "funded", earliestSettlementTimestamp: String(NOW_SECONDS + 1) });

    expect(dvpSettleAvailability(early, NOW_MS)).toBe("too_early");
    expect(dvpSettleAvailability(early, NOW_MS + 1000)).toBe("available");
  });

  it("says unfunded, not expired, for an open trade still short", () => {
    expect(dvpSettleAvailability(trade({ status: "partially_funded" }), NOW_MS)).toBe("unfunded");
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
      expect(dvpSettleAvailability(trade({ status }), NOW_MS)).not.toBe("available");
    }
  });
});

describe("warnings", () => {
  it("finds a leg holding more than its target", () => {
    const over = trade({
      legs: {
        a: testLeg({
          funding: { observedAmount: "1500", funded: true, surplus: "500", frozen: false },
        }),
        b: testLeg({ amount: "2000" }),
      },
    });

    expect(overFundedLegs(over)).toHaveLength(1);
    expect(frozenLegs(over)).toHaveLength(0);
  });

  it("finds a frozen escrow, which a zero balance cannot convey", () => {
    const frozen = trade({
      legs: {
        a: testLeg({
          funding: { observedAmount: "0", funded: false, surplus: null, frozen: true },
        }),
        b: testLeg({ amount: "2000" }),
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

// Which sides the caller holds custody of is the API's per-leg `wallet`,
// read through one helper so no surface writes its own
// `wallet !== null ? "a" : "b"` filter — the half-remembered version of that
// is how agent trades ended up with a fund action on a leg nobody held.
describe("custodiedSidesOf", () => {
  it("is empty when neither party is custodied", () => {
    expect(custodiedSidesOf(trade())).toEqual([]);
  });

  it("names the custodied side on a principal trade", () => {
    const value = trade({
      legs: {
        a: testLeg({ party: ownParty() }),
        b: testLeg(),
      },
    });

    expect(custodiedSidesOf(value)).toEqual(["a"]);
  });

  it("lists both sides, A first, on a bilateral trade", () => {
    const value = trade({
      legs: {
        a: testLeg({ party: ownParty() }),
        b: testLeg({ party: ownParty({ address: OTHER_ADDRESS }) }),
      },
    });

    expect(custodiedSidesOf(value)).toEqual(["a", "b"]);
  });

  // A wallet with no display name is still the caller's custody: the name is
  // display copy, the wallet's presence is the fact.
  it("counts an unnamed wallet as custodied", () => {
    const value = trade({
      legs: {
        a: testLeg({ party: ownParty({ wallet: { id: OWN_WALLET_ID, name: null } }) }),
        b: testLeg(),
      },
    });

    expect(custodiedSidesOf(value)).toEqual(["a"]);
  });
});

// Rendering an outage as "not found" tells someone their trade is gone when it
// is sitting there — and a DvP trade holds both parties' money in escrow, so
// that is the worst available wrong answer.
describe("isNotFound", () => {
  it("is true only for a genuine 404", () => {
    expect(isNotFound({ status: 404 })).toBe(true);
  });

  it("is false for every operational failure", () => {
    for (const status of [429, 500, 502, 503, 401, 403]) {
      expect(isNotFound({ status })).toBe(false);
    }
  });

  // A transport failure never reached the API, so there is no status at all.
  it("is false when the request never got a response", () => {
    expect(isNotFound({ status: null })).toBe(false);
  });
});

/**
 * Searching for a trade by an address you can see.
 *
 * The table renders addresses shortened. Selecting the visible text and pasting
 * it into the search is the obvious move and it found nothing, because the only
 * thing being matched was the full forty-four characters.
 */

describe("matchesAddressQuery", () => {
  const ADDRESS = "BMiuAaumaf6XFdmm1SjQfhYo5pXPq92bU3qEaBEUw1eP";

  it("matches a plain substring", () => {
    expect(matchesAddressQuery(ADDRESS, "bmiuaa")).toBe(true);
  });

  it("matches the shortened form the table renders", () => {
    expect(matchesAddressQuery(ADDRESS, "bmiuaa…w1ep")).toBe(true);
  });

  // Three dots and the ellipsis character are indistinguishable to whoever
  // pasted them, so both have to work.
  it("matches three dots as well as an ellipsis", () => {
    expect(matchesAddressQuery(ADDRESS, "bmiuaa...w1ep")).toBe(true);
  });

  it("does not match a shortened form belonging to another address", () => {
    expect(matchesAddressQuery(ADDRESS, "7wlcnn…xnpg")).toBe(false);
  });

  // A bare ellipsis has no head and no tail. Treating it as "starts with
  // nothing and ends with nothing" would match every row on the page.
  it.each(["…", "...", "…w1ep", "bmiuaa…"])("does not match everything for %s", (query) => {
    expect(matchesAddressQuery(ADDRESS, query)).toBe(false);
  });

  it("still matches an ordinary symbol query", () => {
    expect(matchesAddressQuery("USDC", "usd")).toBe(true);
  });
});
