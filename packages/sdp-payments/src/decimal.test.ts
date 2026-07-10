import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimalStringFromNumber, divideDecimalAmounts, sumDecimalAmounts } from "./decimal";

describe("sumDecimalAmounts", () => {
  it("sums without float artifacts", () => {
    assert.equal(sumDecimalAmounts(["0.05", "0.05", "0.05"]), "0.15");
    assert.equal(sumDecimalAmounts(["0.1", "0.2"]), "0.3");
  });

  it("handles mixed scales and empty input", () => {
    assert.equal(sumDecimalAmounts(["1.5", "2", "0.000000001"]), "3.500000001");
    assert.equal(sumDecimalAmounts([]), "0");
  });
});

describe("divideDecimalAmounts", () => {
  it("divides exactly when the result terminates", () => {
    assert.equal(divideDecimalAmounts("100", "4"), "25");
    assert.equal(divideDecimalAmounts("0.15", "0.05"), "3");
    assert.equal(divideDecimalAmounts("1", "0.5"), "2");
  });

  it("rounds half away from zero at the 9-decimal scale", () => {
    assert.equal(divideDecimalAmounts("1", "3"), "0.333333333");
    assert.equal(divideDecimalAmounts("2", "3"), "0.666666667");
    assert.equal(divideDecimalAmounts("0.000000001", "2"), "0.000000001");
  });

  it("throws on a zero denominator", () => {
    assert.throws(() => divideDecimalAmounts("1", "0"));
    assert.throws(() => divideDecimalAmounts("1", "0.00"));
  });
});

describe("decimalStringFromNumber", () => {
  it("passes plain representations through unchanged", () => {
    assert.equal(decimalStringFromNumber(0), "0");
    assert.equal(decimalStringFromNumber(25.5), "25.5");
    assert.equal(decimalStringFromNumber(0.000001), "0.000001");
    assert.equal(decimalStringFromNumber(-3.25), "-3.25");
  });

  it("expands negative-exponent scientific notation", () => {
    assert.equal(decimalStringFromNumber(1e-7), "0.0000001");
    assert.equal(decimalStringFromNumber(2.5e-8), "0.000000025");
    assert.equal(decimalStringFromNumber(-1.2e-7), "-0.00000012");
  });

  it("expands positive-exponent scientific notation", () => {
    assert.equal(decimalStringFromNumber(1e21), "1000000000000000000000");
    assert.equal(decimalStringFromNumber(1.5e22), "15000000000000000000000");
  });

  it("throws on non-finite values", () => {
    assert.throws(() => decimalStringFromNumber(Number.NaN));
    assert.throws(() => decimalStringFromNumber(Number.POSITIVE_INFINITY));
  });
});
