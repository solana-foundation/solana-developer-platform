import { formatFixedDecimal, parseFixedDecimal } from "@sdp/solana/amount";
import { describe, expect, it } from "vitest";

describe("fixed-point helpers", () => {
  it("parses whole values", () => {
    expect(parseFixedDecimal("0", 6)).toBe(0n);
    expect(parseFixedDecimal("1", 6)).toBe(1_000_000n);
    expect(parseFixedDecimal("42", 0)).toBe(42n);
  });

  it("parses fractional values", () => {
    expect(parseFixedDecimal("1.23", 6)).toBe(1_230_000n);
    expect(parseFixedDecimal("0.5", 6)).toBe(500_000n);
    expect(parseFixedDecimal(".5", 6)).toBe(500_000n);
  });

  it("rejects too many decimal places", () => {
    expect(() => parseFixedDecimal("1.2345678", 6)).toThrow("Amount has too many decimal places");
  });

  it("formats units to decimal strings", () => {
    expect(formatFixedDecimal(0n, 6)).toBe("0");
    expect(formatFixedDecimal(1_000_000n, 6)).toBe("1");
    expect(formatFixedDecimal(1_230_000n, 6)).toBe("1.23");
    expect(formatFixedDecimal(1_234_567n, 6)).toBe("1.234567");
    expect(formatFixedDecimal(500_000n, 6)).toBe("0.5");
  });

  it("formats at scale zero", () => {
    expect(formatFixedDecimal(42n, 0)).toBe("42");
  });
});
