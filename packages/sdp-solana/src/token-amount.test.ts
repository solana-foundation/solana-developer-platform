import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmountError } from "./amount";
import { seededRandom } from "./test/seeded-random";
import {
  baseUnits,
  parseBaseUnits,
  parseTokenAmount,
  toBaseUnits,
  toTokenAmount,
  U64_MAX,
} from "./token-amount";

describe("baseUnits", () => {
  it("accepts the whole u64 range", () => {
    assert.equal(baseUnits(0n), 0n);
    assert.equal(baseUnits(U64_MAX), 18_446_744_073_709_551_615n);
  });

  it("refuses values outside the u64 range", () => {
    assert.throws(() => baseUnits(-1n), AmountError);
    assert.throws(() => baseUnits(U64_MAX + 1n), AmountError);
  });
});

describe("parseBaseUnits", () => {
  it("parses plain whole numbers", () => {
    assert.equal(parseBaseUnits("0"), 0n);
    assert.equal(parseBaseUnits("18446744073709551615"), U64_MAX);
  });

  it("refuses anything that is not a canonical u64", () => {
    for (const value of ["", "01", "-1", "+1", "1.0", "1e3", " 1", "18446744073709551616"]) {
      assert.throws(() => parseBaseUnits(value), AmountError, value);
    }
  });
});

describe("parseTokenAmount", () => {
  it("canonicalizes the decimal string", () => {
    assert.deepEqual(parseTokenAmount(" 001.500 ", 6), { value: "1.5", decimals: 6 });
    assert.deepEqual(parseTokenAmount("2.000000", 6), { value: "2", decimals: 6 });
    assert.deepEqual(parseTokenAmount(".5", 1), { value: "0.5", decimals: 1 });
  });

  it("refuses more fraction digits than the mint has", () => {
    assert.throws(
      () => parseTokenAmount("1.0000001", 6),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Amount has too many decimal places"
    );
  });

  it("refuses an amount above the u64 range in base units", () => {
    assert.deepEqual(parseTokenAmount("18446744073709.551615", 6), {
      value: "18446744073709.551615",
      decimals: 6,
    });
    assert.throws(
      () => parseTokenAmount("18446744073709.551616", 6),
      (error: unknown) => error instanceof AmountError && error.message === "Amount is out of range"
    );
  });

  it("refuses decimals that are not a u8", () => {
    for (const decimals of [-1, 1.5, 256]) {
      assert.throws(() => parseTokenAmount("1", decimals), AmountError, String(decimals));
    }
  });

  it("refuses signed and exponent forms", () => {
    for (const value of ["-1", "1e-6", "", "."]) {
      assert.throws(() => parseTokenAmount(value, 6), AmountError, value);
    }
  });
});

describe("toTokenAmount and toBaseUnits", () => {
  it("round-trips every u64 exactly, above 2^53 included", () => {
    const random = seededRandom(0x5eed_0001n);
    const samples = [0n, 1n, 2n ** 53n + 1n, U64_MAX];
    for (let index = 0; index < 2_000; index += 1) samples.push(random.u64());
    for (const value of samples) {
      const decimals = random.below(20);
      const amount = toTokenAmount(baseUnits(value), decimals);
      assert.equal(toBaseUnits(amount), value);
      assert.deepEqual(parseTokenAmount(amount.value, decimals), amount);
    }
  });

  it("formats at the mint's scale", () => {
    assert.equal(toTokenAmount(baseUnits(1_500_000n), 6).value, "1.5");
    assert.equal(toTokenAmount(baseUnits(1n), 9).value, "0.000000001");
    assert.equal(toTokenAmount(baseUnits(42n), 0).value, "42");
  });
});
