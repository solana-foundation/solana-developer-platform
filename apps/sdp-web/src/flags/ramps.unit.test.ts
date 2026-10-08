import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  type RampProviderFlagReads,
  resolveEnabledRampProviders,
  resolveRampsEnabled,
} from "./ramps";

const on = async () => true;
const off = async () => false;

function providerFlags(enabled: readonly RampProviderId[]): RampProviderFlagReads {
  return Object.fromEntries(
    RAMP_PROVIDERS.map((provider) => [provider, enabled.includes(provider) ? on : off])
  ) as RampProviderFlagReads; // SAFETY: the entries cover every RAMP_PROVIDERS id.
}

describe("resolveEnabledRampProviders", () => {
  it("returns the enabled providers in canonical order", async () => {
    await expect(
      resolveEnabledRampProviders(providerFlags(["stripe", "moonpay"]))
    ).resolves.toEqual(["moonpay", "stripe"]);
  });
});

describe("resolveRampsEnabled", () => {
  it.each([
    ["Payments on with a provider", on, ["moonpay"], true],
    ["Payments off, even with every provider", off, RAMP_PROVIDERS, false],
    ["Payments on with no provider (all capped by the release channel)", on, [], false],
    ["Payments off and no provider", off, [], false],
  ] as const)("%s → %s", async (_, payments, enabled, expected) => {
    await expect(
      resolveRampsEnabled({ payments, providers: providerFlags(enabled) })
    ).resolves.toBe(expected);
  });
});
