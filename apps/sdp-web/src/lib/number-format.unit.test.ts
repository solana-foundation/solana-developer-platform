import { describe, expect, it } from "vitest";
import { formatNumber, formatPercent } from "./number-format";

describe("number format", () => {
  it("groups and fixes the decimals in the reader's locale", () => {
    expect(formatNumber("en", 24800, 2)).toBe("24,800.00");
    expect(formatNumber("en", 100_218_750.4)).toBe("100,218,750");
    expect(formatNumber("de", 96.4, 2)).toBe("96,40");
  });

  it("formats the English-only homepage in English", () => {
    expect(formatNumber("en", 1234.5, 2)).toBe("1,234.50");
  });

  it("reads a rate given in percent", () => {
    expect(formatPercent("en", 4.5, 1)).toBe("4.5%");
  });
});
