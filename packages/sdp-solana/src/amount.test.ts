import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmountError,
  compareDecimalAmounts,
  formatDecimalAmount,
  parseDecimalAmount,
  toMosaicAmount,
  toNumberAmount,
} from "./amount";

describe("toNumberAmount", () => {
  it("converts exactly representable amounts", () => {
    assert.equal(toNumberAmount("0.15"), 0.15);
    assert.equal(toNumberAmount("1234567.12345678"), 1234567.12345678);
    assert.equal(toNumberAmount("0.0000001"), 0.0000001);
  });

  it("throws when the float cannot represent the decimal", () => {
    assert.throws(() => toNumberAmount("12345678901234567.8"), AmountError);
    assert.throws(() => toNumberAmount("0.12345678901234567891"), AmountError);
  });

  it("rejects non-decimal input", () => {
    assert.throws(() => toNumberAmount("1e-7"), AmountError);
    assert.throws(() => toNumberAmount(""), AmountError);
  });
});

describe("toMosaicAmount", () => {
  it("survives amounts whose float form uses scientific notation", () => {
    assert.equal(toMosaicAmount("0.0000001", 9), 0.0000001);
  });
});

describe("kit-backed amount helpers", () => {
  it("formats trailing zeros as trimmed", () => {
    assert.equal(formatDecimalAmount(1500000n, 6), "1.5");
    assert.equal(formatDecimalAmount("1500000", 6), "1.5");
  });

  it("drops the decimal point for whole numbers", () => {
    assert.equal(formatDecimalAmount(2000000n, 6), "2");
  });

  it("formats negative bigints with a leading minus", () => {
    assert.equal(formatDecimalAmount(-1500000n, 6), "-1.5");
    assert.equal(formatDecimalAmount(-2000000n, 6), "-2");
  });

  it("formats an empty string as zero", () => {
    assert.equal(formatDecimalAmount("", 6), "0");
  });

  it("passes through base units when decimals is zero", () => {
    assert.equal(formatDecimalAmount(42n, 0), "42");
    assert.equal(formatDecimalAmount(-7n, 0), "-7");
  });

  it("round-trips a value just above 2^53 exactly", () => {
    const value = "9007199254740993.5";
    const baseUnits = parseDecimalAmount(value, 1);
    assert.equal(baseUnits, 90071992547409935n);
    const formatted = formatDecimalAmount(baseUnits, 1);
    assert.equal(formatted, value);
    assert.equal(parseDecimalAmount(formatted, 1), baseUnits);
  });

  it("parses base units at the target scale", () => {
    assert.equal(parseDecimalAmount("10.5", 6), 10500000n);
  });

  it("parses leading zeros", () => {
    assert.equal(parseDecimalAmount("007.10", 2), 710n);
  });

  it("rejects malformed strings with the exact error message", () => {
    assert.throws(
      () => parseDecimalAmount("1e-7", 6),
      (error: unknown) => error instanceof AmountError && error.message === "Invalid decimal amount"
    );
  });

  it("rejects invalid decimals configuration with the exact error message", () => {
    assert.throws(
      () => parseDecimalAmount("1.5", 1.5),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
    assert.throws(
      () => parseDecimalAmount("1.5", -1),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
    assert.throws(
      () => formatDecimalAmount(1n, -1),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Invalid decimals configuration"
    );
  });

  it("rejects excess precision with the exact error message", () => {
    assert.throws(
      () => parseDecimalAmount("1.5", 0),
      (error: unknown) =>
        error instanceof AmountError && error.message === "Amount has too many decimal places"
    );
  });

  it("throws Amount is out of range beyond 256 bits", () => {
    const absurd = `1${"0".repeat(78)}`;
    assert.throws(
      () => parseDecimalAmount(absurd, 0),
      (error: unknown) => error instanceof AmountError && error.message === "Amount is out of range"
    );
  });

  it("compares amounts across unequal scales", () => {
    assert.equal(compareDecimalAmounts("1.5", "1.50"), 0);
    assert.equal(compareDecimalAmounts("0.1", "0.09"), 1);
    assert.equal(compareDecimalAmounts("0.09", "0.1"), -1);
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
