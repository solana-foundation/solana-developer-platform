import { getDb } from "@/db";
import {
  getOrganizationProviderAvailability,
  syncOrganizationTierFromClerk,
} from "@/services/organization-provider-access.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { resolveOrganizationProviderEntitlements } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_ORG_ID = "org_provider_access_test";

describe("organization-provider-access.service", () => {
  const originalPrivyAppId = env.PRIVY_APP_ID;
  const originalPrivyAppSecret = env.PRIVY_APP_SECRET;
  const originalSolanaRpcUrl = env.SOLANA_RPC_URL;
  const originalRangeApiKey = env.RANGE_API_KEY;
  const originalMoonPayApiKey = env.MOONPAY_API_KEY;
  const originalMoonPaySecretKey = env.MOONPAY_SECRET_KEY;

  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG_ID, "Provider Access Test Org", "provider-access-test-org", "free", "active")
      .run();

    env.PRIVY_APP_ID = "privy_test_app";
    env.PRIVY_APP_SECRET = "privy_test_secret";
    env.SOLANA_RPC_URL = "https://rpc.default.test";
    env.RANGE_API_KEY = "range_test_key";
    env.MOONPAY_API_KEY = "moonpay_test_key";
    env.MOONPAY_SECRET_KEY = "moonpay_test_secret";
  });

  afterEach(async () => {
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    env.SOLANA_RPC_URL = originalSolanaRpcUrl;
    env.RANGE_API_KEY = originalRangeApiKey;
    env.MOONPAY_API_KEY = originalMoonPayApiKey;
    env.MOONPAY_SECRET_KEY = originalMoonPaySecretKey;

    await clearTestDatabase(env);
  });

  it("resolves free defaults and applies provider overrides", () => {
    const resolved = resolveOrganizationProviderEntitlements({
      tier: "free",
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

    expect(resolved.tier).toBe("free");
    expect(resolved.providers.custody.privy).toBe(true);
    expect(resolved.providers.custody.local).toBe(true);
    expect(resolved.providers.custody.para).toBe(false);
    expect(resolved.providers.rpc.default).toBe(true);
    expect(resolved.providers.rpc.helius).toBe(true);
    expect(resolved.providers.compliance.range).toBe(true);
    expect(resolved.providers.ramps.moonpay).toBe(true);
  });

  it("marks providers as enabled only when both entitled and configured", async () => {
    const access = await getOrganizationProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(access.tier).toBe("free");
    expect(access.providers.custody.privy).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(access.providers.custody.para.enabled).toBe(false);
    expect(access.providers.rpc.default.enabled).toBe(true);
    expect(access.providers.compliance.range).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(access.providers.ramps.moonpay.enabled).toBe(false);
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

  it("defaults to free and clears provider overrides when Clerk metadata is absent", async () => {
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

    expect(organization?.tier).toBe("free");
    expect(organization?.settings ? JSON.parse(organization.settings) : null).toEqual({
      rpcProvider: "helius",
    });
  });
});
