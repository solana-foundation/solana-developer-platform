import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmountError, toMosaicAmount, toNumberAmount } from "./amount";

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
