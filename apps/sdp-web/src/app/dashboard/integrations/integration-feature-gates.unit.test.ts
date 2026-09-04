import { describe, expect, it } from "vitest";
import {
  isIntegrationFamilyEnabled,
  isIntegrationProviderEnabled,
} from "./integration-feature-gates";
import type { IntegrationFamily } from "./integrations-filter";

const ALL_DISABLED = {
  custody: false,
  payments: false,
  policies: false,
  privateChannels: false,
};

describe("integration feature gates", () => {
  it("keeps only the general RPC family when every product module is disabled", () => {
    const families: IntegrationFamily[] = ["custody", "rpc", "ramps", "compliance", "privacy"];

    expect(families.filter((family) => isIntegrationFamilyEnabled(family, ALL_DISABLED))).toEqual([
      "rpc",
    ]);
  });

  it.each([
    ["privy", "custody"],
    ["moonpay", "payments"],
    ["range", "policies"],
  ] as const)("gates %s with the %s module", (provider, flag) => {
    expect(isIntegrationProviderEnabled(provider, ALL_DISABLED)).toBe(false);
    expect(isIntegrationProviderEnabled(provider, { ...ALL_DISABLED, [flag]: true })).toBe(true);
  });

  it("keeps general RPC provider routes available", () => {
    expect(isIntegrationProviderEnabled("helius", ALL_DISABLED)).toBe(true);
  });
});
