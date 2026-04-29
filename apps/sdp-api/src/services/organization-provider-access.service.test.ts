import { resolveOrganizationProviderEntitlements } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  getOrganizationProviderAvailability,
  syncOrganizationTierFromClerk,
} from "@/services/organization-provider-access.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_ORG_ID = "org_provider_access_test";

describe("organization-provider-access.service", () => {
  const originalPrivyAppId = env.PRIVY_APP_ID;
  const originalPrivyAppSecret = env.PRIVY_APP_SECRET;
  const originalSolanaRpcUrl = env.SOLANA_RPC_URL;
  const originalSolanaRpcHeliusUrl = env.SOLANA_RPC_HELIUS_URL;
  const originalSolanaRpcTritonUrl = env.SOLANA_RPC_TRITON_URL;
  const originalRangeApiKey = env.RANGE_API_KEY;
  const originalMoonPayApiKey = env.MOONPAY_API_KEY;
  const originalMoonPaySecretKey = env.MOONPAY_SECRET_KEY;
  const originalCoinbaseCdpApiKeyId = env.COINBASE_CDP_API_KEY_ID;
  const originalCoinbaseCdpApiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
  const originalCoinbaseCdpWalletSecret = env.COINBASE_CDP_WALLET_SECRET;
  const originalTurnkeyApiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
  const originalTurnkeyApiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
  const originalTurnkeyOrganizationId = env.TURNKEY_ORGANIZATION_ID;
  const originalCustodyPrivateKey = env.CUSTODY_PRIVATE_KEY;
  const originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;

  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        TEST_ORG_ID,
        "Provider Access Test Org",
        "provider-access-test-org",
        "individual",
        "active"
      )
      .run();

    env.PRIVY_APP_ID = "privy_test_app";
    env.PRIVY_APP_SECRET = "privy_test_secret";
    env.SOLANA_RPC_URL = "https://rpc.default.test";
    env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
    env.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    env.RANGE_API_KEY = "range_test_key";
    env.MOONPAY_API_KEY = "moonpay_test_key";
    env.MOONPAY_SECRET_KEY = "moonpay_test_secret";
    env.COINBASE_CDP_API_KEY_ID = "coinbase_test_key_id";
    env.COINBASE_CDP_API_KEY_SECRET = "coinbase_test_key_secret";
    env.COINBASE_CDP_WALLET_SECRET = "coinbase_test_wallet_secret";
    env.TURNKEY_API_PUBLIC_KEY = "turnkey_test_public_key";
    env.TURNKEY_API_PRIVATE_KEY = "turnkey_test_private_key";
    env.TURNKEY_ORGANIZATION_ID = "turnkey_test_org";
    env.CUSTODY_PRIVATE_KEY = undefined;
    env.SDP_DEPLOYMENT_MODE = undefined;
  });

  afterEach(async () => {
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    env.SOLANA_RPC_URL = originalSolanaRpcUrl;
    env.SOLANA_RPC_HELIUS_URL = originalSolanaRpcHeliusUrl;
    env.SOLANA_RPC_TRITON_URL = originalSolanaRpcTritonUrl;
    env.RANGE_API_KEY = originalRangeApiKey;
    env.MOONPAY_API_KEY = originalMoonPayApiKey;
    env.MOONPAY_SECRET_KEY = originalMoonPaySecretKey;
    env.COINBASE_CDP_API_KEY_ID = originalCoinbaseCdpApiKeyId;
    env.COINBASE_CDP_API_KEY_SECRET = originalCoinbaseCdpApiKeySecret;
    env.COINBASE_CDP_WALLET_SECRET = originalCoinbaseCdpWalletSecret;
    env.TURNKEY_API_PUBLIC_KEY = originalTurnkeyApiPublicKey;
    env.TURNKEY_API_PRIVATE_KEY = originalTurnkeyApiPrivateKey;
    env.TURNKEY_ORGANIZATION_ID = originalTurnkeyOrganizationId;
    env.CUSTODY_PRIVATE_KEY = originalCustodyPrivateKey;
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;

    await clearTestDatabase(env);
  });

  it("resolves individual defaults and applies provider overrides", () => {
    const resolved = resolveOrganizationProviderEntitlements({
      tier: "individual",
      providerOverrides: {
        custody: {
          local: true,
        },
        rpc: {
          helius: true,
        },
        compliance: {
          range: true,
        },
        ramps: {
          moonpay: true,
        },
      },
    });

    expect(resolved.tier).toBe("individual");
    expect(resolved.providers.custody.privy).toBe(true);
    expect(resolved.providers.custody.coinbase_cdp).toBe(true);
    expect(resolved.providers.custody.turnkey).toBe(true);
    expect(resolved.providers.custody.local).toBe(true);
    expect(resolved.providers.custody.para).toBe(false);
    expect(resolved.providers.rpc.default).toBe(true);
    expect(resolved.providers.rpc.helius).toBe(true);
    expect(resolved.providers.rpc.triton).toBe(true);
    expect(resolved.providers.compliance.range).toBe(true);
    expect(resolved.providers.ramps.moonpay).toBe(true);
    expect(resolved.providers.ramps.lightspark).toBe(false);
  });

  it("marks providers as enabled only when both entitled and configured", async () => {
    const access = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(access.tier).toBe("individual");
    expect(access.providers.custody.privy).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(access.providers.custody.coinbase_cdp.enabled).toBe(true);
    expect(access.providers.custody.turnkey.enabled).toBe(true);
    expect(access.providers.custody.para.enabled).toBe(false);
    expect(access.providers.rpc.default.enabled).toBe(true);
    expect(access.providers.rpc.helius.enabled).toBe(true);
    expect(access.providers.rpc.triton.enabled).toBe(true);
    expect(access.providers.compliance.range).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(access.providers.ramps.moonpay.enabled).toBe(true);
    expect(access.providers.ramps.lightspark.enabled).toBe(false);
  });

  it("treats local custody as override-only and only configured when a local key is present", async () => {
    await syncOrganizationTierFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_access_local_test",
        private_metadata: {
          sdp: {
            tier: "individual",
            providerOverrides: {
              custody: {
                local: true,
              },
            },
          },
        },
      },
    });

    const withoutKey = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(withoutKey.providers.custody.local).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });

    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const withKey = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(withKey.providers.custody.local).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
  });

  it("syncs normalized Clerk tier and provider overrides into the organization row", async () => {
    await syncOrganizationTierFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_access_test",
        private_metadata: {
          sdp: {
            tier: "pro",
            providerOverrides: {
              custody: {
                local: true,
                para: false,
              },
              rpc: {
                helius: true,
              },
            },
          },
        },
      },
    });

    const organization = await getDb(env)
      .prepare("SELECT tier, settings FROM organizations WHERE id = ?")
      .bind(TEST_ORG_ID)
      .first<{ tier: string; settings: string | null }>();

    expect(organization?.tier).toBe("enterprise");
    expect(organization?.settings ? JSON.parse(organization.settings) : null).toMatchObject({
      providerOverrides: {
        custody: {
          local: true,
          para: false,
        },
        rpc: {
          helius: true,
        },
      },
    });
  });

  it("entitles every provider in self-hosted mode regardless of tier", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const access = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(access.tier).toBe("individual");
    // local custody is absent from individual tier defaults — the bypass entitles it
    expect(access.providers.custody.local).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    // dfns is absent from individual defaults AND not configured — entitled but not enabled
    expect(access.providers.custody.dfns).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });
    // compliance is empty for individual tier — bypass entitles every provider
    expect(access.providers.compliance.range.entitled).toBe(true);
    // ramps not in individual defaults beyond moonpay — bypass entitles them all
    expect(access.providers.ramps.lightspark.entitled).toBe(true);
    expect(access.providers.ramps.bvnk.entitled).toBe(true);
  });

  it("respects providerOverrides[id] === false in self-hosted mode (disable-only override)", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          providerOverrides: {
            custody: { local: false },
          },
        }),
        TEST_ORG_ID
      )
      .run();

    const access = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(access.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    // Other providers stay entitled
    expect(access.providers.custody.privy.entitled).toBe(true);
  });

  it("does NOT bypass entitlements when SDP_DEPLOYMENT_MODE is unset (managed-mode regression)", async () => {
    env.SDP_DEPLOYMENT_MODE = undefined;
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const access = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(access.tier).toBe("individual");
    // local is configured but NOT entitled in managed individual tier — must stay disabled
    expect(access.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    // compliance is still empty for individual tier in managed mode
    expect(access.providers.compliance.range.entitled).toBe(false);
  });

  it("defaults to enterprise and clears provider overrides when Clerk metadata is absent", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET tier = ?, settings = ? WHERE id = ?")
      .bind(
        "enterprise",
        JSON.stringify({
          providerOverrides: {
            custody: {
              local: true,
            },
          },
          rpcProvider: "helius",
        }),
        TEST_ORG_ID
      )
      .run();

    await syncOrganizationTierFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_access_default_test",
      },
    });

    const organization = await getDb(env)
      .prepare("SELECT tier, settings FROM organizations WHERE id = ?")
      .bind(TEST_ORG_ID)
      .first<{ tier: string; settings: string | null }>();

    expect(organization?.tier).toBe("enterprise");
    expect(organization?.settings ? JSON.parse(organization.settings) : null).toEqual({
      rpcProvider: "helius",
    });
  });
});
