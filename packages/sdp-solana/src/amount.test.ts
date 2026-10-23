import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmountError,
  addDecimalAmounts,
  compareDecimalAmounts,
  formatFixedDecimal,
  parseFixedDecimal,
  parseTokenAmount,
  scaleDecimalAmountByBps,
  sumDecimalAmounts,
} from "./amount";

describe("kit-backed fixed-point helpers", () => {
  it("formats trailing zeros as trimmed", () => {
    assert.equal(formatFixedDecimal(1500000n, 6), "1.5");
  });

  it("drops the decimal point for whole numbers", () => {
    assert.equal(formatFixedDecimal(2000000n, 6), "2");
  });

  it("formats negative bigints with a leading minus", () => {
    assert.equal(formatFixedDecimal(-1500000n, 6), "-1.5");
    assert.equal(formatFixedDecimal(-2000000n, 6), "-2");
  });

  it("passes the units through at scale zero", () => {
    assert.equal(formatFixedDecimal(42n, 0), "42");
    assert.equal(formatFixedDecimal(-7n, 0), "-7");
  });

  it("round-trips a value just above 2^53 exactly", () => {
    const value = "9007199254740993.5";
    const units = parseFixedDecimal(value, 1);
    assert.equal(units, 90071992547409935n);
    const formatted = formatFixedDecimal(units, 1);
    assert.equal(formatted, value);
    assert.equal(parseFixedDecimal(formatted, 1), units);
  });

  it("parses units at the target scale", () => {
    assert.equal(parseFixedDecimal("10.5", 6), 10500000n);
  });

  it("parses leading zeros", () => {
    assert.equal(parseFixedDecimal("007.10", 2), 710n);
  });

  it("rejects malformed strings with the exact error message", () => {
    assert.throws(
      () => parseFixedDecimal("1e-7", 6),
      (error: unknown) => error instanceof AmountError && error.message === "Invalid decimal amount"
    );
  });

  it("rejects an invalid scale with the exact error message", () => {
    assert.throws(
      () => parseFixedDecimal("1.5", 1.5),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
    assert.throws(
      () => parseFixedDecimal("1.5", -1),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
    assert.throws(
      () => formatFixedDecimal(1n, -1),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
  });

  it("rejects excess precision with the exact error message", () => {
    assert.throws(
      () => parseFixedDecimal("1.5", 0),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Amount has too many decimal places"
    );
  });

  it("throws Amount is out of range beyond 256 bits", () => {
    const absurd = `1${"0".repeat(78)}`;
    assert.throws(
      () => parseFixedDecimal(absurd, 0),
      (error: unknown) => error instanceof AmountError && error.message === "Amount is out of range"
    );
  });

  it("compares amounts across unequal scales", () => {
    assert.equal(compareDecimalAmounts("1.5", "1.50"), 0);
    assert.equal(compareDecimalAmounts("0.1", "0.09"), 1);
    assert.equal(compareDecimalAmounts("0.09", "0.1"), -1);
  });

  it("adds amounts exactly across unequal scales", () => {
    assert.equal(addDecimalAmounts("1.5", "2.25"), "3.75");
    assert.equal(addDecimalAmounts("0", "100000"), "100000");
    assert.equal(addDecimalAmounts("99999.999999", "0.000001"), "100000");
    assert.equal(addDecimalAmounts("0.1", "0.2"), "0.3");
  });

  it("rejects an invalid addend", () => {
    assert.throws(() => addDecimalAmounts("1.0", "abc"), AmountError);
  });

  it("scales by basis points, truncating to the amount's own scale", () => {
    assert.equal(scaleDecimalAmountByBps("50000000", 1000), "5000000");
    assert.equal(scaleDecimalAmountByBps("1234.56", 10000), "1234.56");
    assert.equal(scaleDecimalAmountByBps("100", 0), "0");
    // 0.15 * 33.33% = 0.049995, truncated at two decimals, never rounded up.
    assert.equal(scaleDecimalAmountByBps("0.15", 3333), "0.04");
    assert.equal(scaleDecimalAmountByBps("7", 5000), "3");
  });

  it("rejects an invalid scale input", () => {
    assert.throws(() => scaleDecimalAmountByBps("abc", 1000), AmountError);
    assert.throws(() => scaleDecimalAmountByBps("10", -1), AmountError);
    assert.throws(() => scaleDecimalAmountByBps("10", 1.5), AmountError);
  });

  it("compares high-scale inputs that kit's assertValidDecimals must accept", () => {
    const tinyHighScale = `0.${"0".repeat(299)}1`;
    assert.equal(compareDecimalAmounts(tinyHighScale, "0"), 1);
    assert.equal(compareDecimalAmounts(tinyHighScale, tinyHighScale), 0);
  });

  it("throws Amount is out of range for compare inputs beyond 256 bits", () => {
    const hugeFraction = `0.${"1".repeat(300)}`;
    assert.throws(
      () => compareDecimalAmounts(hugeFraction, "0.1"),
      (error: unknown) => error instanceof AmountError && error.message === "Amount is out of range"
    );
  });
});

describe("parseTokenAmount", () => {
  it("accepts the full u64 range without floating-point conversion", () => {
    assert.equal(parseTokenAmount("9007199254.740993", 6), 9007199254740993n);
    assert.equal(parseTokenAmount("18446744073709.551615", 6), 18446744073709551615n);
  });
  it("rejects excess precision and u64 overflow", () => {
    assert.throws(() => parseTokenAmount("1.0000001", 6), AmountError);
    assert.throws(() => parseTokenAmount("18446744073709.551616", 6), AmountError);
  });
});

describe("sumDecimalAmounts", () => {
  it("adds at the largest scale, exactly, past a float's precision", () => {
    assert.equal(sumDecimalAmounts(["1.25", "0.75", "2"]), "4");
    assert.equal(sumDecimalAmounts(["0.1", "0.2"]), "0.3");
    assert.equal(
      sumDecimalAmounts(["9007199254740993.000000001", "1.000000001"]),
      "9007199254740994.000000002"
    );
  });

  it("is 0 for no amounts and refuses a malformed one", () => {
    assert.equal(sumDecimalAmounts([]), "0");
    assert.throws(() => sumDecimalAmounts(["1", "1e3"]), AmountError);
  });
});
