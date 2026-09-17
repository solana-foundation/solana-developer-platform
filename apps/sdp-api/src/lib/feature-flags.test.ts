import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import {
  isAssetProfilesEnabled,
  isCustodyConnectionRuntimeEnabled,
  isEarnEnabled,
  isEarnVaultSponsorshipEnabled,
  isMarketsEnabled,
  isPrivateChannelsEnabled,
  isPrivyByokEnabled,
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
    const both = { ...devnetOnly, KORA_MAINNET_RPC_URL: "https://kora-mainnet.example" } as Env;
    expect(isEarnVaultSponsorshipEnabled(both, "mainnet-beta")).toBe(true);
  });

  it("limits the native fee payer to the process default cluster", () => {
    const env = { ...devnetOnly, FEE_PAYMENT_PROVIDER: "native" } as Env;
    expect(isEarnVaultSponsorshipEnabled(env, "devnet")).toBe(true);
    expect(isEarnVaultSponsorshipEnabled(env, "mainnet-beta")).toBe(false);
  });
});
