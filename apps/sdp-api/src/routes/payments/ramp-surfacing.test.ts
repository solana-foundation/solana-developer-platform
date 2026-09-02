import { isRampProviderSurfaced, surfacedRampProviders } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";

describe("ramp provider surfacing", () => {
  it("surfaces moneygram only in sandbox during the pilot", () => {
    expect(isRampProviderSurfaced("moneygram", "sandbox")).toBe(true);
    expect(isRampProviderSurfaced("moneygram", "production")).toBe(false);
  });

  it("surfaces always-on providers in both environments", () => {
    expect(isRampProviderSurfaced("moonpay", "sandbox")).toBe(true);
    expect(isRampProviderSurfaced("moonpay", "production")).toBe(true);
  });

  it("fails closed for unknown ids and prototype keys", () => {
    expect(isRampProviderSurfaced("not-a-provider", "sandbox")).toBe(false);
    expect(isRampProviderSurfaced("toString", "sandbox")).toBe(false);
  });

  it("derives the surfaced list per environment", () => {
    expect(surfacedRampProviders("sandbox")).toContain("moneygram");
    expect(surfacedRampProviders("production")).not.toContain("moneygram");
  });
});
