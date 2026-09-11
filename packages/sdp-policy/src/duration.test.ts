import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isIsoDuration, parseIsoDurationMs } from "./duration";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseIsoDurationMs", () => {
  it("accepts the day, hour and minute subset and their combinations", () => {
    assert.equal(parseIsoDurationMs("P1D"), DAY);
    assert.equal(parseIsoDurationMs("P30D"), 30 * DAY);
    assert.equal(parseIsoDurationMs("PT1H"), HOUR);
    assert.equal(parseIsoDurationMs("PT15M"), 15 * MINUTE);
    assert.equal(parseIsoDurationMs("PT1H30M"), HOUR + 30 * MINUTE);
    assert.equal(parseIsoDurationMs("P1DT12H"), DAY + 12 * HOUR);
    assert.equal(parseIsoDurationMs("P1DT12H5M"), DAY + 12 * HOUR + 5 * MINUTE);
  });

  it("rejects everything outside the subset", () => {
    for (const window of [
      "",
      "P",
      "PT",
      "P1DT",
      "P1W",
      "P1M",
      "P1Y",
      "PT30S",
      "PT1.5H",
      "-P1D",
      "P1H",
      "PT1D",
      "PT1M1H",
      "1D",
      "P1D ",
      " P1D",
      "p1d",
      "P0D",
      "PT0M",
    ]) {
      assert.equal(parseIsoDurationMs(window), null, window);
      assert.equal(isIsoDuration(window), false, window);
    }
  });

  it("accepts a valid window through the boolean helper", () => {
    assert.equal(isIsoDuration("PT1H"), true);
  });
});
