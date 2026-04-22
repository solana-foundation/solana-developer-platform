import { describe, expect, it } from "vitest";
import { formatDecimalAmount, parseDecimalAmount, toMosaicAmount } from "@/lib/amount";

describe("amount helpers", () => {
  it("parses integer amounts", () => {
    expect(parseDecimalAmount("0", 6)).toBe(0n);
    expect(parseDecimalAmount("1", 6)).toBe(1_000_000n);
    expect(parseDecimalAmount("42", 0)).toBe(42n);
  });

  it("parses fractional amounts", () => {
    expect(parseDecimalAmount("1.23", 6)).toBe(1_230_000n);
    expect(parseDecimalAmount("0.5", 6)).toBe(500_000n);
    expect(parseDecimalAmount(".5", 6)).toBe(500_000n);
  });

  it("rejects too many decimal places", () => {
    expect(() => parseDecimalAmount("1.2345678", 6)).toThrow("Amount has too many decimal places");
  });

  it("formats base units to decimal strings", () => {
    expect(formatDecimalAmount(0n, 6)).toBe("0");
    expect(formatDecimalAmount(1_000_000n, 6)).toBe("1");
    expect(formatDecimalAmount(1_230_000n, 6)).toBe("1.23");
    expect(formatDecimalAmount(1_234_567n, 6)).toBe("1.234567");
    expect(formatDecimalAmount(500_000n, 6)).toBe("0.5");
  });

  it("formats amounts with zero decimals", () => {
    expect(formatDecimalAmount(42n, 0)).toBe("42");
  });

  it("creates safe Mosaic amounts", () => {
    expect(toMosaicAmount("1.5", 6)).toBe(1.5);
    expect(toMosaicAmount("100", 0)).toBe(100);
  });
});
