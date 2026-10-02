import {
  isModuleInReleaseChannel,
  isRampProviderInReleaseChannel,
  RAMP_PROVIDERS,
  type RampProviderId,
  resolveSdpReleaseChannel,
  SDP_MODULES,
  SDP_RELEASE_CHANNELS,
  type SdpReleaseChannel,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import {
  assertSdpReleaseChannelConfigured,
  isAssetProfilesEnabled,
  isCustodyConnectionRuntimeEnabled,
  isDvpEnabled,
  isEarnEnabled,
  isEarnHastraDexExitConfigured,
  isEarnHastraDexExitEnabled,
  isEarnVaultSponsorshipEnabled,
  isHeliusRingsEnabled,
  isMarketsEnabled,
  isModuleAvailable,
  isPrivateChannelsEnabled,
  isPrivyByokEnabled,
  isRampProviderAvailable,
  resolveNewCustodySetupMethod,
} from "./feature-flags";

describe("isAssetProfilesEnabled", () => {
  it.each([undefined, "managed"] as const)(
    "keeps the managed API capability available when deployment mode is %s",
    (deploymentMode) => {
      expect(
        isAssetProfilesEnabled({
          ENVIRONMENT: "production",
          SDP_DEPLOYMENT_MODE: deploymentMode,
        })
      ).toBe(true);
    }
  );

  it.each([undefined, "", "false", "0", "off"])(
    "enables Asset Profiles in development when the flag is %s",
    (flag) => {
      expect(
        isAssetProfilesEnabled({
          ENVIRONMENT: "development",
          SDP_FLAG_ASSET_PROFILES: flag,
          SDP_DEPLOYMENT_MODE: "self_hosted",
        })
      ).toBe(true);
    }
  );

  it.each([undefined, "", "false", "0", "off"])(
    "keeps Asset Profiles disabled in production when the flag is %s",
    (flag) => {
      expect(
        isAssetProfilesEnabled({
          ENVIRONMENT: "production",
          SDP_FLAG_ASSET_PROFILES: flag,
          SDP_DEPLOYMENT_MODE: "self_hosted",
        })
      ).toBe(false);
    }
  );

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the production opt-in value %s", (flag) => {
    expect(
      isAssetProfilesEnabled({
        ENVIRONMENT: "production",
        SDP_FLAG_ASSET_PROFILES: flag,
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    ).toBe(true);
  });
});

describe("isPrivateChannelsEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(isPrivateChannelsEnabled({ PRIVATE_CHANNELS_ENABLED: flag })).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(isPrivateChannelsEnabled({ PRIVATE_CHANNELS_ENABLED: flag })).toBe(true);
  });
});

describe("isPrivyByokEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(
      isPrivyByokEnabled({
        PRIVY_BYOK_ENABLED: flag,
      })
    ).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(
      isPrivyByokEnabled({
        PRIVY_BYOK_ENABLED: flag,
      })
    ).toBe(true);
  });
});

describe("isCustodyConnectionRuntimeEnabled", () => {
  it("uses the Privy rollout flag only for Privy Connections", () => {
    expect(isCustodyConnectionRuntimeEnabled({ PRIVY_BYOK_ENABLED: "true" }, "privy")).toBe(true);
    expect(isCustodyConnectionRuntimeEnabled({ PRIVY_BYOK_ENABLED: "false" }, "privy")).toBe(false);
    expect(isCustodyConnectionRuntimeEnabled({ PRIVY_BYOK_ENABLED: "true" }, "turnkey")).toBe(
      false
    );
  });
});

describe("resolveNewCustodySetupMethod", () => {
  it.each([
    [{ PRIVY_BYOK_ENABLED: "false" }, "privy", "legacy_config"],
    [{ PRIVY_BYOK_ENABLED: "true" }, "turnkey", "legacy_config"],
    [{ PRIVY_BYOK_ENABLED: "true", SDP_DEPLOYMENT_MODE: "managed" }, "privy", "stored_credentials"],
    [
      {
        PRIVY_BYOK_ENABLED: "true",
        SDP_DEPLOYMENT_MODE: "self_hosted",
        SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED: "true",
      },
      "privy",
      "stored_credentials",
    ],
    [
      {
        PRIVY_BYOK_ENABLED: "true",
        SDP_DEPLOYMENT_MODE: "self_hosted",
        SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED: "false",
      },
      "privy",
      "deployment_credentials",
    ],
  ] as const)("resolves %j for %s to %s", (env, provider, expected) => {
    expect(resolveNewCustodySetupMethod(env, provider)).toBe(expected);
  });
});

describe("isMarketsEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(isMarketsEnabled({ MARKETS_ENABLED: flag })).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(isMarketsEnabled({ MARKETS_ENABLED: flag })).toBe(true);
  });
});

describe("isEarnEnabled", () => {
  it("is disabled when both flags are unset", () => {
    expect(isEarnEnabled({ MARKETS_ENABLED: undefined, EARN_ENABLED: undefined })).toBe(false);
  });

  it("is disabled when Markets is on but Earn is unset", () => {
    expect(isEarnEnabled({ MARKETS_ENABLED: "true", EARN_ENABLED: undefined })).toBe(false);
  });

  // The parent gate has to win: Earn is a Markets sub-module, so disabling
  // Markets must dark-launch Earn even with its own flag still turned on.
  it.each([undefined, "", "false", "0", "off"])(
    "stays disabled when Earn is on but Markets is %s",
    (markets) => {
      expect(isEarnEnabled({ MARKETS_ENABLED: markets, EARN_ENABLED: "true" })).toBe(false);
    }
  );

  it.each(["1", "true", " TRUE ", "yes", "on"])(
    "honors the opt-in value %s on both flags",
    (flag) => {
      expect(isEarnEnabled({ MARKETS_ENABLED: flag, EARN_ENABLED: flag })).toBe(true);
    }
  );
});

describe("isEarnHastraDexExitEnabled", () => {
  it.each([undefined, "", "false", "0", "off"])("is disabled when the flag is %s", (flag) => {
    expect(isEarnHastraDexExitEnabled({ EARN_HASTRA_DEX_EXIT_ENABLED: flag })).toBe(false);
  });

  it.each(["1", "true", " TRUE ", "yes", "on"])("honors the opt-in value %s", (flag) => {
    expect(isEarnHastraDexExitEnabled({ EARN_HASTRA_DEX_EXIT_ENABLED: flag })).toBe(true);
  });

  it("requires both the rollout flag and the Jupiter runtime key to be configured", () => {
    expect(
      isEarnHastraDexExitConfigured({
        EARN_HASTRA_DEX_EXIT_ENABLED: "true",
        JUPITER_SWAP_API_KEY: undefined,
      })
    ).toBe(false);
    expect(
      isEarnHastraDexExitConfigured({
        EARN_HASTRA_DEX_EXIT_ENABLED: undefined,
        JUPITER_SWAP_API_KEY: "jup_test_key",
      })
    ).toBe(false);
    expect(
      isEarnHastraDexExitConfigured({
        EARN_HASTRA_DEX_EXIT_ENABLED: "true",
        JUPITER_SWAP_API_KEY: " jup_test_key ",
      })
    ).toBe(true);
  });
});

describe("isEarnVaultSponsorshipEnabled", () => {
  // Which clusters sponsor is configuration: the flag AND a paymaster for the
  // cluster. Opening mainnet is wiring its Kora in, never a code change.
  const devnetOnly = {
    EARN_VAULT_FEE_SPONSORSHIP_ENABLED: "true",
    SOLANA_NETWORK: "devnet",
    KORA_RPC_URL: "https://kora-devnet.example",
  } as Env;

  it("is off without the flag, whatever paymasters are configured", () => {
    const env = { ...devnetOnly, EARN_VAULT_FEE_SPONSORSHIP_ENABLED: undefined } as Env;
    expect(isEarnVaultSponsorshipEnabled(env, "devnet")).toBe(false);
  });

  it("sponsors only the clusters that have a paymaster", () => {
    expect(isEarnVaultSponsorshipEnabled(devnetOnly, "devnet")).toBe(true);
    expect(isEarnVaultSponsorshipEnabled(devnetOnly, "mainnet-beta")).toBe(false);
    const both = { ...devnetOnly, KORA_RPC_URL_MAINNET: "https://kora-mainnet.example" } as Env;
    expect(isEarnVaultSponsorshipEnabled(both, "mainnet-beta")).toBe(true);
  });

  it("limits the native fee payer to the process default cluster", () => {
    const env = { ...devnetOnly, FEE_PAYMENT_PROVIDER: "native" } as Env;
    expect(isEarnVaultSponsorshipEnabled(env, "devnet")).toBe(true);
    expect(isEarnVaultSponsorshipEnabled(env, "mainnet-beta")).toBe(false);
  });
});

describe("release channels", () => {
  it.each([undefined, "", "  "])(
    "defaults to the experimental release channel when SDP_RELEASE_CHANNEL is %j",
    (value) => {
      expect(resolveSdpReleaseChannel(value)).toBe("experimental");
    }
  );

  it("fails loudly on an unknown release channel instead of running every module", () => {
    expect(() => resolveSdpReleaseChannel("mainnet")).toThrow(/SDP_RELEASE_CHANNEL must be one of/);
  });

  it("requires an explicit release channel in managed production only", () => {
    const managedProduction = {
      ENVIRONMENT: "production",
      SDP_DEPLOYMENT_MODE: "managed",
    } as const;
    expect(() => assertSdpReleaseChannelConfigured(managedProduction)).toThrow(
      /SDP_RELEASE_CHANNEL is required/
    );
    expect(() =>
      assertSdpReleaseChannelConfigured({ ...managedProduction, SDP_RELEASE_CHANNEL: "stable" })
    ).not.toThrow();
    expect(() =>
      assertSdpReleaseChannelConfigured({
        ...managedProduction,
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    ).not.toThrow();
    expect(() =>
      assertSdpReleaseChannelConfigured({
        ENVIRONMENT: "development",
        SDP_DEPLOYMENT_MODE: "managed",
      })
    ).not.toThrow();
    expect(() =>
      assertSdpReleaseChannelConfigured({
        ENVIRONMENT: "development",
        SDP_RELEASE_CHANNEL: "mainnet",
      })
    ).toThrow(/SDP_RELEASE_CHANNEL must be one of/);
  });

  it("keeps every module available in the experimental release channel", () => {
    for (const module of SDP_MODULES) {
      expect(isModuleAvailable({ SDP_RELEASE_CHANNEL: "experimental" }, module)).toBe(true);
    }
  });

  // Pinned on purpose: changing what stable ships must show up in review
  // as an edit to this list, not only to the manifest.
  // A module runs in every release channel at or below its own maturity.
  it.each([
    ["experimental", "ramps", true],
    ["beta", "ramps", false],
    ["stable", "ramps", false],
    ["experimental", "custody", true],
    ["beta", "custody", true],
    ["stable", "custody", true],
  ] as const)("a %s deployment runs %s: %s", (releaseChannel, module, expected) => {
    expect(isModuleInReleaseChannel(releaseChannel, module)).toBe(expected);
  });

  it("runs ramps only where at least one ramp provider is in the release channel", () => {
    const allExperimental = Object.fromEntries(
      RAMP_PROVIDERS.map((p) => [p, "experimental"])
    ) as Record<RampProviderId, SdpReleaseChannel>;
    expect(isModuleInReleaseChannel("stable", "ramps", allExperimental)).toBe(false);
    expect(isModuleInReleaseChannel("experimental", "ramps", allExperimental)).toBe(true);

    const bvnkInBeta = { ...allExperimental, bvnk: "beta" } as const;
    expect(isModuleInReleaseChannel("beta", "ramps", bvnkInBeta)).toBe(true);
    expect(isModuleInReleaseChannel("stable", "ramps", bvnkInBeta)).toBe(false);
    expect(isRampProviderInReleaseChannel("beta", "bvnk", bvnkInBeta)).toBe(true);
    expect(isRampProviderInReleaseChannel("beta", "moonpay", bvnkInBeta)).toBe(false);
  });

  it("keeps every ramp provider out of stable until it is promoted", () => {
    for (const provider of RAMP_PROVIDERS) {
      expect(isRampProviderAvailable({ SDP_RELEASE_CHANNEL: "stable" }, provider)).toBe(false);
      expect(isRampProviderAvailable({ SDP_RELEASE_CHANNEL: "experimental" }, provider)).toBe(true);
    }
  });

  it("pins the stable modules", () => {
    expect(SDP_RELEASE_CHANNELS.stable).toEqual([
      "custody",
      "payments",
      "recurring_payments",
      "compliance",
    ]);
  });

  it("keeps release-channel-excluded modules off in stable even with every flag on", () => {
    const env = {
      SDP_RELEASE_CHANNEL: " stable ",
      MARKETS_ENABLED: "true",
      EARN_ENABLED: "true",
      PRIVATE_CHANNELS_ENABLED: "true",
      HELIUS_RINGS_ENABLED: "true",
      SDP_FLAG_ASSET_PROFILES: "true",
    } as Env;

    expect(isMarketsEnabled(env)).toBe(false);
    expect(isEarnEnabled(env)).toBe(false);
    expect(isDvpEnabled(env)).toBe(false);
    expect(isPrivateChannelsEnabled(env)).toBe(false);
    expect(isHeliusRingsEnabled(env)).toBe(false);
    expect(isAssetProfilesEnabled({ ...env, SDP_DEPLOYMENT_MODE: "managed" })).toBe(false);
    expect(isAssetProfilesEnabled({ ...env, SDP_DEPLOYMENT_MODE: "self_hosted" })).toBe(false);
  });

  it("leaves release-channel-included features to their flags", () => {
    const env = { SDP_RELEASE_CHANNEL: "experimental", MARKETS_ENABLED: "true" } as Env;
    expect(isDvpEnabled(env)).toBe(true);
    expect(isDvpEnabled({ ...env, MARKETS_ENABLED: undefined })).toBe(false);
  });
});
