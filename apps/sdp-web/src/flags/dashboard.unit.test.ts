import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { SdpModule } from "@sdp/types/release-channels";
import { describe, expect, it, vi } from "vitest";
import { capDashboardFlagsToEnvironment, type DashboardFlags } from "./dashboard";

const channel = vi.hoisted(() => {
  const outOfProduction: readonly SdpModule[] = ["issuance", "earn", "markets"];
  return { outOfProduction };
});

vi.mock("@/flags/release-channel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/flags/release-channel")>()),
  isModuleInEnvironmentReleaseChannel: (module: SdpModule, environment: SdpEnvironment) =>
    environment !== "production" || !channel.outOfProduction.includes(module),
}));

const ALL_ON = {
  assetProfiles: true,
  compliance: true,
  custody: true,
  dvp: true,
  earn: true,
  heliusRings: true,
  issuance: true,
  markets: true,
  payments: true,
  paymentsDemoMode: true,
  privateChannels: true,
  releaseChannel: "beta",
  ramps: true,
} as const satisfies DashboardFlags;

describe("capDashboardFlagsToEnvironment", () => {
  it("turns off each module the channel leaves out for the Project's environment", () => {
    expect(capDashboardFlagsToEnvironment(ALL_ON, "production")).toEqual({
      ...ALL_ON,
      assetProfiles: false,
      earn: false,
      issuance: false,
      markets: false,
    });
    expect(capDashboardFlagsToEnvironment(ALL_ON, "sandbox")).toEqual(ALL_ON);
  });
});
