import { describe, expect, it } from "vitest";
import {
  isIntegrationFamilyEnabled,
  isIntegrationProviderEnabled,
} from "./integration-feature-gates";
import type { IntegrationFamily } from "./integrations-filter";

const ALL_DISABLED = {
  custody: false,
  ramps: false,
  compliance: false,
  privateChannels: false,
  newDesign: true,
};

describe("integration feature gates", () => {
  it.each([
    ["custody", "custody"],
    ["ramps", "ramps"],
    ["compliance", "compliance"],
    ["privacy", "privateChannels"],
  ] as const satisfies ReadonlyArray<readonly [IntegrationFamily, keyof typeof ALL_DISABLED]>)(
    "shows the %s family only with the %s module",
    (family, flag) => {
      expect(isIntegrationFamilyEnabled(family, ALL_DISABLED)).toBe(false);
      expect(isIntegrationFamilyEnabled(family, { ...ALL_DISABLED, [flag]: true })).toBe(true);
    }
  );

  it.each([
    ["privy", "custody"],
    ["moonpay", "ramps"],
    ["range", "compliance"],
  ] as const)("gates %s with the %s module", (provider, flag) => {
    expect(isIntegrationProviderEnabled(provider, ALL_DISABLED)).toBe(false);
    expect(isIntegrationProviderEnabled(provider, { ...ALL_DISABLED, [flag]: true })).toBe(true);
  });
});
