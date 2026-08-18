import { describe, expect, it } from "vitest";
import { formatProviderAmount, formatTokenQuantity, formatUsd } from "./earn-format";

describe("exact Earn amount formatting", () => {
  it("groups provider decimals beyond JavaScript's safe integer range without coercion", () => {
    expect(formatProviderAmount("9007199254740993.129", "USDC", 3, 3)).toBe(
      "9,007,199,254,740,993.129 USDC"
    );
    expect(formatUsd("9007199254740993.129")).toBe("$9,007,199,254,740,993.129");
  });

  it("preserves unavailable values instead of displaying zero", () => {
    expect(formatProviderAmount(undefined, "USDC")).toBe("—");
    expect(formatUsd("not-a-decimal")).toBe("—");
    expect(formatTokenQuantity(undefined, "USDC")).toBe("—");
  });

  it("uses the same exact formatter for token quantities", () => {
    expect(formatTokenQuantity("001234.500000", "USDC")).toBe("1,234.5 USDC");
    expect(formatTokenQuantity("0.009001", "USDC")).toBe("0.009001 USDC");
  });
});
