import { isActiveIso4217CurrencyCode } from "@sdp/payments/ramps/shared";
import { describe, expect, it } from "vitest";

describe("ramp rail distillation", () => {
  it("validates ISO 4217 currency codes", () => {
    expect(isActiveIso4217CurrencyCode("ADP")).toBe(false);
    expect(isActiveIso4217CurrencyCode("MXN")).toBe(true);
  });
});
