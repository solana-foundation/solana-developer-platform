import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareDecimalAmounts,
  decimalStringFromNumber,
  divideDecimalAmounts,
  multiplyDecimalAmounts,
  subtractDecimalAmounts,
  sumDecimalAmounts,
} from "./decimal";
import { SdpPaymentsError } from "./errors";

describe("compareDecimalAmounts", () => {
  it("compares a u64 amount against one at 20+ fractional digits exactly", () => {
    assert.equal(compareDecimalAmounts("18446744073709551615", "0.18446744073709551615"), 1);
    assert.equal(
      compareDecimalAmounts("1.000000000000000000000000001", "1.000000000000000000000000001"),
      0
    );
    assert.equal(compareDecimalAmounts("0.00000000000000000000000001", "1"), -1);
  });
});

describe("sumDecimalAmounts", () => {
  it("sums an empty list to 0", () => {
    assert.equal(sumDecimalAmounts([]), "0");
  });

  it("refuses an amount past 128 bits at its scale as a bad request", () => {
    assert.throws(
      () => sumDecimalAmounts(["18446744073709551615", "0.000000000000000000001"]),
      (error) =>
        error instanceof SdpPaymentsError &&
        error.statusCode === 400 &&
        error.message === "Amount is out of range"
    );
  });

  it("refuses a sum past the range as a bad request", () => {
    const half = "170141183460469231731687303715884105728";
    assert.throws(
      () => sumDecimalAmounts([half, half]),
      (error) => error instanceof SdpPaymentsError && error.statusCode === 400
    );
  });
});

describe("subtractDecimalAmounts", () => {
  it("subtracts without float artifacts", () => {
    assert.equal(subtractDecimalAmounts("110.5", "100"), "10.5");
    assert.equal(subtractDecimalAmounts("0.3", "0.1"), "0.2");
  });

  it("signs a genuinely negative difference and never signs zero", () => {
    assert.equal(subtractDecimalAmounts("9", "10"), "-1");
    assert.equal(subtractDecimalAmounts("1.25", "1.250"), "0");
  });

  it("handles mixed scales exactly", () => {
    assert.equal(subtractDecimalAmounts("2", "0.000000001"), "1.999999999");
  });
});

describe("multiplyDecimalAmounts", () => {
  it("multiplies exactly at the inputs' combined precision", () => {
    assert.equal(multiplyDecimalAmounts("1.5", "2"), "3");
    assert.equal(multiplyDecimalAmounts("2", "1.5"), "3");
    assert.equal(multiplyDecimalAmounts("0.5", "1.111592"), "0.555796");
  });

  it("refuses a malformed or out-of-range amount", () => {
    assert.throws(
      () => multiplyDecimalAmounts("abc", "1"),
      (error) => error instanceof SdpPaymentsError && error.statusCode === 400
    );
    assert.throws(
      () => multiplyDecimalAmounts("18446744073709551615", "0.000000000000000000001"),
      (error) =>
        error instanceof SdpPaymentsError &&
        error.statusCode === 400 &&
        error.message === "Amount is out of range"
    );
  });

  it("refuses a product past the range as a bad request", () => {
    const root = "18446744073709551616";
    assert.throws(
      () => multiplyDecimalAmounts(root, root),
      (error) => error instanceof SdpPaymentsError && error.statusCode === 400
    );
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

  it("refuses a zero denominator as a bad request", () => {
    for (const zero of ["0", "0.00"]) {
      assert.throws(
        () => divideDecimalAmounts("1", zero),
        (error) => error instanceof SdpPaymentsError && error.statusCode === 400
      );
    }
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

  it("refuses a non-finite value as a bad request", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => decimalStringFromNumber(value),
        (error) => error instanceof SdpPaymentsError && error.statusCode === 400
      );
    }
  });
});
