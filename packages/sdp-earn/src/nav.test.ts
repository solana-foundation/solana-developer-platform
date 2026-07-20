import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecimalScaled, positionValueBaseUnits, sharesForDepositBaseUnits } from "./nav";

describe("parseDecimalScaled", () => {
  it("scales whole and fractional parts", () => {
    assert.equal(parseDecimalScaled("1"), 10n ** 18n);
    assert.equal(parseDecimalScaled("1.5"), 15n * 10n ** 17n);
    assert.equal(parseDecimalScaled("0.000001", 6), 1n);
  });

  it("truncates precision beyond the scale", () => {
    assert.equal(parseDecimalScaled("1.9999", 2), 199n);
  });

  it("rejects malformed input", () => {
    assert.throws(() => parseDecimalScaled("-1"));
    assert.throws(() => parseDecimalScaled("1.2.3"));
    assert.throws(() => parseDecimalScaled("abc"));
    assert.throws(() => parseDecimalScaled(""));
  });
});

describe("positionValueBaseUnits", () => {
  it("is identity at a share price of 1", () => {
    assert.equal(positionValueBaseUnits("1000000", "1"), 1000000n);
  });

  it("applies accrued yield", () => {
    // 1,000,000 shares at 1.05 → 1,050,000 base units.
    assert.equal(positionValueBaseUnits("1000000", "1.05"), 1050000n);
  });

  it("floors fractional results", () => {
    assert.equal(positionValueBaseUnits("3", "1.5"), 4n);
  });

  it("rejects negative share amounts", () => {
    assert.throws(() => positionValueBaseUnits("-1", "1"));
  });
});

describe("sharesForDepositBaseUnits", () => {
  it("is identity at a share price of 1", () => {
    assert.equal(sharesForDepositBaseUnits("1000000", "1"), 1000000n);
  });

  it("floors shares when the price has appreciated", () => {
    // 1,000,000 base units at 1.05 → 952,380.95… shares, floored.
    assert.equal(sharesForDepositBaseUnits("1000000", "1.05"), 952380n);
  });

  it("rejects a zero share price", () => {
    assert.throws(() => sharesForDepositBaseUnits("1000000", "0"));
  });

  it("round-trips conservatively with positionValueBaseUnits", () => {
    const shares = sharesForDepositBaseUnits("1000000", "1.037");
    const value = positionValueBaseUnits(shares.toString(), "1.037");
    assert.ok(value <= 1000000n);
    assert.ok(value >= 999998n);
  });
});
