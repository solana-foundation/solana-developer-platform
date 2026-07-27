import { describe, expect, it } from "vitest";
import { formatTokenAmount } from "./payments-overview.utils";

const normalizeSpaces = (value: string) => value.replace(/[  ]/g, " ");

describe("formatTokenAmount", () => {
  it("groups English amounts with commas and a dot decimal", () => {
    expect(formatTokenAmount("1234567.89", "en")).toBe("1,234,567.89");
  });

  it("groups French amounts with spaces and a comma decimal", () => {
    expect(normalizeSpaces(formatTokenAmount("1234567.89", "fr"))).toBe("1 234 567,89");
  });

  it("keeps every input digit on high-precision amounts", () => {
    expect(formatTokenAmount("123456789.123456789", "en")).toBe("123,456,789.123456789");
  });

  it("preserves the sign on fractional negative amounts", () => {
    expect(formatTokenAmount("-0.5", "en")).toBe("-0.5");
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatTokenAmount("not-a-number", "fr")).toBe("not-a-number");
  });
});
