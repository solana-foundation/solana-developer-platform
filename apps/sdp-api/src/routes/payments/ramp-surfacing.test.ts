import { isRampProviderSurfaced, RETIRED_RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";

describe("ramp provider surfacing", () => {
  it("surfaces always-on providers in both environments", () => {
    expect(isRampProviderSurfaced("moonpay", "sandbox")).toBe(true);
    expect(isRampProviderSurfaced("moonpay", "production")).toBe(true);
  });

  it("never surfaces a retired provider", () => {
    for (const provider of RETIRED_RAMP_PROVIDERS) {
      expect(isRampProviderSurfaced(provider, "sandbox")).toBe(false);
      expect(isRampProviderSurfaced(provider, "production")).toBe(false);
    }
  });

  it("fails closed for unknown ids and prototype keys", () => {
    expect(isRampProviderSurfaced("not-a-provider", "sandbox")).toBe(false);
    expect(isRampProviderSurfaced("toString", "sandbox")).toBe(false);
  });
});
