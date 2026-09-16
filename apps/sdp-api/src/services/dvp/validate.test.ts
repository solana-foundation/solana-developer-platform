import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type DvpTradeTerms, validateDvpTerms } from "./validate";

const NOW = 1_800_000_000;

function terms(overrides: Partial<DvpTradeTerms> = {}): DvpTradeTerms {
  return {
    userA: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userB: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
    settlementAuthority: address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"),
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    amountA: 1_000n,
    amountB: 2_000n,
    expiryTimestamp: BigInt(NOW + 3600),
    earliestSettlementTimestamp: null,
    refString: null,
    // Already resolved by the time terms are checked: create substitutes each
    // party's own address for an omitted destination, mirroring the program.
    userASettlementDestination: address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn"),
    userBSettlementDestination: address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg"),
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

  // Not a program rule. The program has no opinion about who the settlement
  // authority belongs to; here it is always SDP's, and it is the key that signs
  // the delivery. Pointing a party's proceeds at it means the tokens move from
  // escrow into SDP's own account instead of to the party.
  it.each([["userASettlementDestination"], ["userBSettlementDestination"]])(
    "rejects %s pointing at the settlement authority",
    (field) => {
      const t = terms({ [field]: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY" });

      expect(validateDvpTerms(t, NOW)).toContain(`${field} must not be the settlementAuthority`);
    }
  );

  // The whole point of the feature: delivering somewhere other than the address
  // that funded the leg is legitimate and must stay accepted.
  it("accepts destinations that differ from their parties", () => {
    const t = terms({
      userASettlementDestination: address("AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC"),
      userBSettlementDestination: address("BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh"),
    });

    expect(validateDvpTerms(t, NOW)).toEqual([]);
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
