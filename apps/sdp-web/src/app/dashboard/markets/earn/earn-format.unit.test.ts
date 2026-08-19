import { describe, expect, it } from "vitest";
import { formatProviderAmount, formatTokenQuantity, formatUsd } from "./earn-format";

describe("Earn display formatting", () => {
  it("renders provider decimals exactly, past the safe-integer boundary", () => {
    expect(formatProviderAmount("9007199254740993.129", "en-US", "USDC", 3, 3)).toBe(
      "9,007,199,254,740,993.129 USDC"
    );
    expect(formatUsd("9007199254740993.129", "en-US")).toBe("$9,007,199,254,740,993.129");
  });

  it("truncates rather than rounding a balance up", () => {
    // Rounding up would offer an amount the provider then refuses.
    expect(formatProviderAmount("1.9999999", "en-US")).toBe("1.999999");
  });

  it("groups digits per the caller's locale", () => {
    expect(formatUsd("1234567.89", "de-DE")).toBe("$1.234.567,89");
  });

  it("renders an em dash for missing or malformed values", () => {
    expect(formatProviderAmount(undefined, "en-US", "USDC")).toBe("—");
    expect(formatUsd("not-a-decimal", "en-US")).toBe("—");
    expect(formatTokenQuantity(undefined, "en-US", "USDC")).toBe("—");
  });

  it("normalizes leading and trailing zeroes", () => {
    expect(formatTokenQuantity("001234.500000", "en-US", "USDC")).toBe("1,234.5 USDC");
    expect(formatTokenQuantity("0.009001", "en-US", "USDC")).toBe("0.009001 USDC");
  });
});
