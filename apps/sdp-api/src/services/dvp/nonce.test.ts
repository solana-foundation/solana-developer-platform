import { describe, expect, it } from "vitest";
import { MAX_U64, randomDvpNonce } from "./nonce";

describe("randomDvpNonce", () => {
  it("returns a bigint, never a number", () => {
    // The nonce is a PDA seed. A JS number above 2^53 rounds, which derives a
    // different SwapDvp address than the one the counterparty was told to fund.
    expect(typeof randomDvpNonce()).toBe("bigint");
  });

  it("stays inside the u64 range the program encodes", () => {
    for (let i = 0; i < 200; i++) {
      const nonce = randomDvpNonce();
      expect(nonce >= 0n).toBe(true);
      expect(nonce <= MAX_U64).toBe(true);
    }
  });

  it("does not repeat across a large sample", () => {
    // Not a randomness proof, just a smoke test that it is not a counter or a
    // constant. A predictable nonce lets a third party squat the trade's address
    // before the real parties get there.
    const seen = new Set<bigint>();
    for (let i = 0; i < 2_000; i++) {
      seen.add(randomDvpNonce());
    }

    expect(seen.size).toBe(2_000);
  });

  it("uses the full width rather than a small integer range", () => {
    // A generator built on Math.random() * 2**32, or anything else that only
    // fills the low bits, would fail this: across 500 draws essentially all of
    // them should exceed 2^53, the point above which a JS number stops being
    // able to hold the value at all.
    const draws = Array.from({ length: 500 }, () => randomDvpNonce());
    const aboveSafeInteger = draws.filter((n) => n > BigInt(Number.MAX_SAFE_INTEGER));

    expect(aboveSafeInteger.length).toBeGreaterThan(490);
  });
});
