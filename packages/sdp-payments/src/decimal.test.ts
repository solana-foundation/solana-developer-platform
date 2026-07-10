import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { divideDecimalAmounts, sumDecimalAmounts } from "./decimal";

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
