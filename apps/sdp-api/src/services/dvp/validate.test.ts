import { describe, expect, it } from "vitest";
import { type DvpTradeTerms, validateDvpTerms } from "./validate";

const NOW = 1_800_000_000;

function terms(overrides: Partial<DvpTradeTerms> = {}): DvpTradeTerms {
  return {
    userA: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userB: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    amountA: 1_000n,
    amountB: 2_000n,
    expiryTimestamp: BigInt(NOW + 3600),
    earliestSettlementTimestamp: null,
    refString: null,
    ...overrides,
  };
}

describe("validateDvpTerms", () => {
  it("accepts a well-formed trade", () => {
    expect(validateDvpTerms(terms(), NOW)).toEqual([]);
  });

  // Program error 5, ExpiryNotInFuture.
  it("rejects an expiry in the past", () => {
    expect(validateDvpTerms(terms({ expiryTimestamp: BigInt(NOW - 1) }), NOW)).toContain(
      "expiryTimestamp must be in the future"
    );
  });

  // Program error 14. Bounds how long escrow rent can be locked.
  it("rejects an expiry more than a year out", () => {
    const overAYear = BigInt(NOW + 366 * 24 * 60 * 60);

    expect(validateDvpTerms(terms({ expiryTimestamp: overAYear }), NOW)).toContain(
      "expiryTimestamp must be within one year"
    );
  });

  // Program error 6.
  it("rejects an earliest-settlement after expiry", () => {
    const t = terms({ earliestSettlementTimestamp: BigInt(NOW + 7200) });

    expect(validateDvpTerms(t, NOW)).toContain(
      "earliestSettlementTimestamp must not be after expiryTimestamp"
    );
  });

  // Program error 7, SelfDvp.
  it("rejects a trade with itself", () => {
    const t = terms({ userB: terms().userA });

    expect(validateDvpTerms(t, NOW)).toContain("userA and userB must differ");
  });

  // Program error 8, SameMint.
  it("rejects both legs on the same mint", () => {
    const t = terms({ mintB: terms().mintA });

    expect(validateDvpTerms(t, NOW)).toContain("mintA and mintB must differ");
  });

  // Program error 9, ZeroAmount.
  it("rejects a zero amount on either leg", () => {
    expect(validateDvpTerms(terms({ amountA: 0n }), NOW)).toContain(
      "amountA must be greater than 0"
    );
    expect(validateDvpTerms(terms({ amountB: 0n }), NOW)).toContain(
      "amountB must be greater than 0"
    );
  });

  // Program error 11, SettlementAuthorityIsParty. The authority crosses the
  // trade, so it cannot also be one of the sides.
  it("rejects a settlement authority that is one of the parties", () => {
    const t = terms({ settlementAuthority: terms().userA });

    expect(validateDvpTerms(t, NOW)).toContain("settlementAuthority must not be userA or userB");
  });

  // Program error 15. Stored zero-padded into a fixed 64-byte field.
  it("rejects a ref string longer than 64 bytes", () => {
    expect(validateDvpTerms(terms({ refString: "x".repeat(65) }), NOW)).toContain(
      "refString must be at most 64 bytes"
    );
  });

  it("measures the ref string in bytes, not characters", () => {
    // 32 emoji is 32 characters but 128 bytes of UTF-8, so a length check on
    // .length would wave this through and the program would reject it.
    expect(validateDvpTerms(terms({ refString: "🙂".repeat(32) }), NOW)).toContain(
      "refString must be at most 64 bytes"
    );
  });

  it("reports every problem at once rather than the first", () => {
    const t = terms({ amountA: 0n, mintB: terms().mintA });

    expect(validateDvpTerms(t, NOW)).toHaveLength(2);
  });
});
