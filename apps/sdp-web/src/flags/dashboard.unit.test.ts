import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardFlags } from "./dashboard";

vi.mock("@/flags", () => ({
  assetProfiles: async () => false,
  newDesign: async () => false,
  newDesignActivity: async () => false,
  newDesignContacts: async () => false,
  newDesignOverview: async () => false,
  newDesignPayDeposit: async () => false,
  newDesignWallets: async () => false,
  paymentsDemoMode: async () => false,
  rampProviderBvnk: async () => false,
  rampProviderMoonpay: async () => false,
  rampProviderStripe: async () => false,
}));

describe("getDashboardFlags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      releaseChannel: "experimental",
      modules: {
        issuance: true,
        privateChannels: true,
        heliusRings: true,
        dvp: true,
        markets: true,
        earn: true,
      },
    },
    {
      releaseChannel: "beta",
      modules: {
        issuance: false,
        privateChannels: false,
        heliusRings: false,
        dvp: false,
        markets: true,
        earn: true,
      },
    },
    {
      releaseChannel: "stable",
      modules: {
        issuance: false,
        privateChannels: false,
        heliusRings: false,
        dvp: false,
        markets: false,
        earn: false,
      },
    },
  ] as const)(
    "serves the $releaseChannel release channel's modules with no flag of their own",
    async ({ releaseChannel, modules }) => {
      vi.stubEnv("SDP_RELEASE_CHANNEL", releaseChannel);

      expect(await getDashboardFlags()).toMatchObject({ ...modules, releaseChannel });
    }
  );
});
