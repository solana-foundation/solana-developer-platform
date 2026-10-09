import { describe, expect, it } from "vitest";
import {
  isIntegrationFamilyEnabled,
  isIntegrationProviderEnabled,
} from "./integration-feature-gates";
import type { IntegrationFamily } from "./integrations-filter";

const ALL_DISABLED = {
  custody: false,
  rampProviders: [],
  compliance: false,
  privateChannels: false,
};

const ENABLED = {
  custody: true,
  rampProviders: ["moonpay"],
  compliance: true,
  privateChannels: true,
} as const;

describe("integration feature gates", () => {
  it.each([
    ["custody", "custody"],
    ["ramps", "rampProviders"],
    ["compliance", "compliance"],
    ["privacy", "privateChannels"],
  ] as const satisfies ReadonlyArray<readonly [IntegrationFamily, keyof typeof ALL_DISABLED]>)(
    "shows the %s family only with %s",
    (family, flag) => {
      expect(isIntegrationFamilyEnabled(family, ALL_DISABLED)).toBe(false);
      expect(isIntegrationFamilyEnabled(family, { ...ALL_DISABLED, [flag]: ENABLED[flag] })).toBe(
        true
      );
    }
  );

  it.each([
    ["privy", "custody"],
    ["moonpay", "rampProviders"],
    ["range", "compliance"],
  ] as const)("gates %s with %s", (provider, flag) => {
    expect(isIntegrationProviderEnabled(provider, ALL_DISABLED)).toBe(false);
    expect(isIntegrationProviderEnabled(provider, { ...ALL_DISABLED, [flag]: ENABLED[flag] })).toBe(
      true
    );
  });

  it("gates each ramp provider on its own, not on whether any ramp is offered", () => {
    const flags = { ...ALL_DISABLED, rampProviders: ["moonpay"] as const };

    expect(isIntegrationProviderEnabled("moonpay", flags)).toBe(true);
    expect(isIntegrationProviderEnabled("lightspark", flags)).toBe(false);
  });
});
