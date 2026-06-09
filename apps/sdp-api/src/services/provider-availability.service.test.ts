import { resolveOrganizationProviderEntitlements } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  assertProviderAvailable,
  getProviderAvailability,
  syncProviderAccessFromClerk,
} from "@/services/provider-availability.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_ORG_ID = "org_provider_availability_test";

const providerEnvKeys = [
  "CUSTODY_PRIVATE_KEY",
  "FIREBLOCKS_API_KEY",
  "FIREBLOCKS_API_SECRET",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "COINBASE_CDP_API_KEY_ID",
  "COINBASE_CDP_API_KEY_SECRET",
  "COINBASE_CDP_WALLET_SECRET",
  "PARA_API_KEY",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_ORGANIZATION_ID",
  "DFNS_AUTH_TOKEN",
  "DFNS_CREDENTIAL_ID",
  "DFNS_PRIVATE_KEY",
  "ANCHORAGE_API_KEY",
  "UTILA_SERVICE_ACCOUNT_EMAIL",
  "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
  "UTILA_VAULT_ID",
  "SOLANA_RPC_URL",
  "SOLANA_RPC_ALCHEMY_URL",
  "SOLANA_RPC_HELIUS_URL",
  "SOLANA_RPC_QUICKNODE_URL",
  "SOLANA_RPC_TRITON_URL",
  "RANGE_API_KEY",
  "ELLIPTIC_API_TOKEN",
  "ELLIPTIC_API_KEY",
  "ELLIPTIC_API_SECRET",
  "TRM_API_KEY",
  "CHAINALYSIS_API_KEY",
  "MOONPAY_API_KEY",
  "MOONPAY_SECRET_KEY",
  "LIGHTSPARK_GRID_CLIENT_ID",
  "LIGHTSPARK_GRID_CLIENT_SECRET",
  "BVNK_HAWK_AUTH_ID",
  "BVNK_HAWK_SECRET_KEY",
  "BVNK_WALLET_ID",
] as const;

type ProviderEnvKey = (typeof providerEnvKeys)[number];
type ProviderEnvSnapshot = Record<ProviderEnvKey, string | undefined>;

function readProviderEnv(): ProviderEnvSnapshot {
  const record = env as unknown as Record<ProviderEnvKey, string | undefined>;
  return Object.fromEntries(
    providerEnvKeys.map((key) => [key, record[key]])
  ) as ProviderEnvSnapshot;
}

function writeProviderEnv(values: Partial<ProviderEnvSnapshot>): void {
  const record = env as unknown as Record<ProviderEnvKey, string | undefined>;
  for (const key of providerEnvKeys) {
    record[key] = values[key];
  }
}

function setBaseProviderEnv(): void {
  writeProviderEnv({
    PRIVY_APP_ID: "privy_test_app",
    PRIVY_APP_SECRET: "privy_test_secret",
    SOLANA_RPC_URL: "https://rpc.default.test",
    SOLANA_RPC_HELIUS_URL: "https://rpc.helius.test",
    SOLANA_RPC_TRITON_URL: "https://rpc.triton.test",
    RANGE_API_KEY: "range_test_key",
    MOONPAY_API_KEY: "moonpay_test_key",
    MOONPAY_SECRET_KEY: "moonpay_test_secret",
    COINBASE_CDP_API_KEY_ID: "coinbase_test_key_id",
    COINBASE_CDP_API_KEY_SECRET: "coinbase_test_key_secret",
    COINBASE_CDP_WALLET_SECRET: "coinbase_test_wallet_secret",
    TURNKEY_API_PUBLIC_KEY: "turnkey_test_public_key",
    TURNKEY_API_PRIVATE_KEY: "turnkey_test_private_key",
    TURNKEY_ORGANIZATION_ID: "turnkey_test_org",
  });
}

async function setOrganizationTier(tier: "individual" | "enterprise"): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET tier = ? WHERE id = ?")
    .bind(tier, TEST_ORG_ID)
    .run();
}

describe("provider-availability.service", () => {
  let originalProviderEnv: ProviderEnvSnapshot;
  let originalDeploymentMode: "managed" | "self_hosted" | undefined;

  beforeEach(async () => {
    originalProviderEnv = readProviderEnv();
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;

    writeProviderEnv({});
    setBaseProviderEnv();
    env.SDP_DEPLOYMENT_MODE = undefined;

    await seedTestDatabase(env);

    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        TEST_ORG_ID,
        "Provider Availability Test Org",
        "provider-availability-test-org",
        "individual",
        "active"
      )
      .run();
  });

  afterEach(async () => {
    writeProviderEnv(originalProviderEnv);
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

  it("marks providers available only when the organization is entitled and the environment is configured", async () => {
    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.tier).toBe("individual");
    expect(availability.providers.custody.privy).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.custody.coinbase_cdp.enabled).toBe(true);
    expect(availability.providers.custody.turnkey.enabled).toBe(true);
    expect(availability.providers.custody.para.enabled).toBe(false);
    expect(availability.providers.rpc.default.enabled).toBe(true);
    expect(availability.providers.rpc.helius.enabled).toBe(true);
    expect(availability.providers.rpc.triton.enabled).toBe(true);
    expect(availability.providers.compliance.range).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(availability.providers.ramps.moonpay).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.ramps.lightspark.enabled).toBe(false);
  });

  it("explains when a configured provider is not entitled for the organization", async () => {
    await expect(
      assertProviderAvailable(env, getDb(env), TEST_ORG_ID, "compliance", "range")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Range is only available on the enterprise tier.",
    });
  });

  it("explains when an entitled provider is not configured in the environment", async () => {
    await setOrganizationTier("enterprise");
    env.RANGE_API_KEY = undefined;

    await expect(
      assertProviderAvailable(env, getDb(env), TEST_ORG_ID, "compliance", "range")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Range is not configured in this environment.",
    });
  });

  it("treats partially configured multi-secret providers as not configured", async () => {
    await setOrganizationTier("enterprise");
    env.BVNK_WALLET_ID = "bvnk_wallet";
    env.BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
    env.BVNK_HAWK_SECRET_KEY = undefined;

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.providers.ramps.bvnk).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });
  });

  it("treats local custody as override-only and only configured when a local key is present", async () => {
    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_availability_local_test",
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

    const withoutKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(withoutKey.providers.custody.local).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });

    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const withKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(withKey.providers.custody.local).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
  });

  it("syncs normalized Clerk tier and provider overrides into the organization row", async () => {
    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_availability_test",
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

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.tier).toBe("individual");
    expect(availability.providers.custody.local).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.custody.dfns).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });
    expect(availability.providers.compliance.range.entitled).toBe(true);
    expect(availability.providers.ramps.lightspark.entitled).toBe(true);
    expect(availability.providers.ramps.bvnk.entitled).toBe(true);
  });

  it("respects providerOverrides[id] === false in self-hosted mode", async () => {
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

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(availability.providers.custody.privy.entitled).toBe(true);
  });

  it("does not bypass entitlements when SDP_DEPLOYMENT_MODE is unset", async () => {
    env.SDP_DEPLOYMENT_MODE = undefined;
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.tier).toBe("individual");
    expect(availability.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(availability.providers.compliance.range.entitled).toBe(false);
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

    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_provider_availability_default_test",
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
