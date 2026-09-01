import { resolveOrganizationProviderEntitlements } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  assertEarnProviderConfigured,
  assertProviderAvailable,
  getProviderAvailability,
  isPersistedCustodyCompletionEnabled,
  syncProviderAccessFromClerk,
} from "@/services/provider-availability.service";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

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
  "IBM_HAVEN_AUTH_TOKEN",
  "IBM_HAVEN_CREDENTIAL_ID",
  "IBM_HAVEN_PRIVATE_KEY",
  "ANCHORAGE_API_KEY",
  "UTILA_SERVICE_ACCOUNT_EMAIL",
  "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
  "UTILA_VAULT_ID",
  "SOLANA_RPC_URL",
  "SOLANA_RPC_ALCHEMY_URL",
  "SOLANA_RPC_HELIUS_URL",
  "SOLANA_RPC_QUICKNODE_URL",
  "SOLANA_RPC_TRITON_URL",
  "SOLANA_RPC_VALIDATIONCLOUD_URL",
  "SOLANA_RPC_NODIT_URL",
  "SOLANA_RPC_NODIT_API_KEY",
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
  "UPSHIFT_API_KEY",
  "UPSHIFT_SANDBOX_API_KEY",
  "PERENA_API_KEY",
  "PERENA_SANDBOX_API_KEY",
  "GROUND_API_KEY",
  "GROUND_SANDBOX_API_KEY",
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
    SOLANA_RPC_VALIDATIONCLOUD_URL: "https://rpc.validationcloud.test/v1/{API_KEY}",
    SOLANA_RPC_NODIT_URL: "https://solana-devnet.nodit.io/{API_KEY}",
    SOLANA_RPC_NODIT_API_KEY: "nodit_test_key",
    RANGE_API_KEY: "range_test_key",
    MOONPAY_API_KEY: "moonpay_test_key",
    MOONPAY_SECRET_KEY: "moonpay_test_secret",
    COINBASE_CDP_API_KEY_ID: "coinbase_test_key_id",
    COINBASE_CDP_API_KEY_SECRET: "coinbase_test_key_secret",
    COINBASE_CDP_WALLET_SECRET: "coinbase_test_wallet_secret",
    PARA_API_KEY: "para_test_key",
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
  let originalPrivyByokEnabled: string | undefined;
  let originalSelfHostedStoredSetupEnabled: string | undefined;

  beforeEach(async () => {
    originalProviderEnv = readProviderEnv();
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    originalPrivyByokEnabled = env.PRIVY_BYOK_ENABLED;
    originalSelfHostedStoredSetupEnabled = env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED;

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
    env.PRIVY_BYOK_ENABLED = originalPrivyByokEnabled;
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = originalSelfHostedStoredSetupEnabled;
  });

  it("resolves general defaults independently of the legacy tier value", () => {
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
    expect(resolved.providers.custody.para).toBe(true);
    expect(resolved.providers.rpc.default).toBe(true);
    expect(resolved.providers.rpc.helius).toBe(true);
    expect(resolved.providers.rpc.triton).toBe(true);
    expect(resolved.providers.rpc.validationcloud).toBe(true);
    expect(resolved.providers.rpc.nodit).toBe(true);
    expect(resolved.providers.compliance.range).toBe(true);
    expect(resolved.providers.ramps.moonpay).toBe(true);
    expect(resolved.providers.ramps.lightspark).toBe(true);
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
    expect(availability.providers.custody.para.enabled).toBe(true);
    expect(availability.providers.rpc.default.enabled).toBe(true);
    expect(availability.providers.rpc.helius.enabled).toBe(true);
    expect(availability.providers.rpc.triton.enabled).toBe(true);
    expect(availability.providers.rpc.validationcloud).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.rpc.nodit).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
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
    expect(availability.providers.ramps.lightspark.entitled).toBe(true);
  });

  it("explains when a configured provider is not entitled for the organization", async () => {
    await expect(
      assertProviderAvailable(env, getDb(env), TEST_ORG_ID, "compliance", "range")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Range requires manual activation for this organization.",
    });
  });

  it("explains when an entitled provider is not configured in the environment", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { compliance: { range: true } } }), TEST_ORG_ID)
      .run();
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

  it.each(["individual", "enterprise"] as const)(
    "treats configured Nodit as general for the legacy %s tier and honors an explicit disable",
    async (tier) => {
      await setOrganizationTier(tier);

      const enabled = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
      expect(enabled.providers.rpc.nodit).toEqual({
        entitled: true,
        configured: true,
        enabled: true,
      });

      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ providerOverrides: { rpc: { nodit: false } } }), TEST_ORG_ID)
        .run();

      const disabled = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
      expect(disabled.providers.rpc.nodit).toEqual({
        entitled: false,
        configured: true,
        enabled: false,
      });
    }
  );

  it("treats Nodit as configured when its URL is present like other RPC providers", async () => {
    env.SOLANA_RPC_NODIT_URL = "https://rpc.proxy.test/nodit";
    env.SOLANA_RPC_NODIT_API_KEY = undefined;

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.providers.rpc.nodit).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
  });

  it("treats local custody as override-only and configurable only in a self-hosted deployment", async () => {
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

    const managedWithKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(managedWithKey.providers.custody.local).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });

    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    const selfHostedWithKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);
    expect(selfHostedWithKey.providers.custody.local).toEqual({
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
    expect(availability.providers.custody.ibm_haven).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });
    expect(availability.providers.compliance.range.entitled).toBe(true);
    expect(availability.providers.ramps.lightspark.entitled).toBe(true);
    expect(availability.providers.ramps.bvnk.entitled).toBe(true);
  });

  it("keeps persisted Privy sources eligible when the fresh setup preference changes", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.PRIVY_BYOK_ENABLED = "true";

    for (const storedSetupEnabled of ["false", "true"]) {
      env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = storedSetupEnabled;

      await expect(
        isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "stored")
      ).resolves.toBe(true);
      await expect(
        isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "runtime")
      ).resolves.toBe(true);
    }
  });

  it("requires a configured runtime binding but not deployment credentials for a persisted stored source", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;

    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "stored")
    ).resolves.toBe(true);
    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "runtime")
    ).resolves.toBe(false);
  });

  it("requires BYOK enablement for both persisted Credential sources", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.PRIVY_BYOK_ENABLED = "false";

    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "stored")
    ).resolves.toBe(false);
    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "runtime")
    ).resolves.toBe(false);
  });

  it("requires custody entitlement for both persisted Credential sources", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.PRIVY_BYOK_ENABLED = "true";
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { custody: { privy: false } } }), TEST_ORG_ID)
      .run();

    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "stored")
    ).resolves.toBe(false);
    await expect(
      isPersistedCustodyCompletionEnabled(env, getDb(env), TEST_ORG_ID, "privy", "runtime")
    ).resolves.toBe(false);
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
      configured: false,
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

  it("resolves earn entitlements as override-only, regardless of tier", () => {
    // Earn providers require manual activation: no tier grants them by default.
    const individual = resolveOrganizationProviderEntitlements({
      tier: "individual",
      providerOverrides: { earn: { veda: true } },
    });
    expect(individual.providers.earn.veda).toBe(true);
    expect(individual.providers.earn.upshift).toBe(false);

    const enterprise = resolveOrganizationProviderEntitlements({ tier: "enterprise" });
    // Exhaustive on purpose: a new earn provider must show up here as a failing
    // assertion, so nobody adds one that a tier silently entitles. `kamino`
    // defaults false like the rest even though it needs no credential —
    // entitlement and configuration are separate gates, and only money-in
    // consults entitlement (a catalogue-only provider never reaches it).
    expect(enterprise.providers.earn).toEqual({
      veda: false,
      upshift: false,
      perena: false,
      ground: false,
      kamino: false,
    });
  });

  it("reports earn provider availability from override entitlement plus configured credentials", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { upshift: true } } }), TEST_ORG_ID)
      .run();
    env.UPSHIFT_API_KEY = "upshift_test_key";

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.providers.earn.upshift).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.earn.perena).toEqual({
      entitled: false,
      configured: false,
      enabled: false,
    });
  });

  /**
   * Veda reaches its vaults on-chain through `@sdp/veda`, so it has no provider
   * API and no credential — the same shape as Kamino. Pinned here because
   * declaring a credential nothing reads would make every environment report
   * Veda unconfigured while withdrawals still had to work.
   */
  it("reports a keyless earn provider as configured with no credentials set", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { veda: true } } }), TEST_ORG_ID)
      .run();

    const availability = await getProviderAvailability(env, getDb(env), TEST_ORG_ID);

    expect(availability.providers.earn.veda).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
  });

  it("re-checks earn credentials for the requested mode like ramps", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { upshift: true } } }), TEST_ORG_ID)
      .run();
    env.UPSHIFT_API_KEY = "upshift_production_key";

    await expect(
      assertProviderAvailable(env, getDb(env), TEST_ORG_ID, "earn", "upshift", false)
    ).resolves.toBeUndefined();

    await expect(
      assertProviderAvailable(env, getDb(env), TEST_ORG_ID, "earn", "upshift", true)
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Upshift is not configured for sandbox mode.",
    });
  });

  it("assertEarnProviderConfigured gates on credentials only, ignoring entitlement (exit safety)", () => {
    // No earn override is granted, so zero providers are entitled, but
    // withdrawals must still pass as long as the provider credentials exist
    // for the mode.
    env.UPSHIFT_API_KEY = "upshift_production_key";

    expect(() => assertEarnProviderConfigured(env, "upshift", false)).not.toThrow();

    expect(() => assertEarnProviderConfigured(env, "upshift", true)).toThrow(
      "Upshift is not configured for sandbox mode."
    );
    expect(() => assertEarnProviderConfigured(env, "perena", false)).toThrow(
      "Perena is not configured for production mode."
    );
    // Keyless, so the exit path is never blocked on a credential that does not
    // exist — the ADR 0002 "money out beats money off" half of the same rule.
    expect(() => assertEarnProviderConfigured(env, "veda", true)).not.toThrow();
  });
});
