import {
  type CustodyMode,
  type CustodyProvider,
  EARN_PROVIDERS,
  RAMP_PROVIDERS,
  resolveOrganizationProviderEntitlements,
  SDP_RAMP_PROVIDER_STAGES,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import {
  admitByokCustodySetup,
  assertCustodyProviderEnabled,
  assertCustodyProviderEntitled,
  assertCustodySetupAdmitted,
  assertEarnProviderConfigured,
  CustodySetupRefusedError,
  custodyProviderNotInReleaseChannel,
  getProjectProviderAvailability,
  getProviderAvailability,
  parseClerkOrganizationTierMetadata,
  parseProviderOverridesFromClerkMetadata,
  syncProviderAccessFromClerk,
} from "@/services/provider-availability.service";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { EARN_ENABLED_FLAGS, EARN_FLAG_OFF_CASES } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import {
  type SeededDefaultProjects,
  type SeededProject,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const MANIFEST_STAGES = { rampProviderStages: SDP_RAMP_PROVIDER_STAGES };

const TEST_ORG_ID = "org_provider_availability_test";
const TEST_USER_ID = "usr_provider_availability_test";
const NOT_ENTITLED_REFUSAL = {
  code: "FORBIDDEN",
  statusCode: 403,
  message: "Privy requires manual activation for this organization.",
  details: { reason: "provider_not_entitled" },
};

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
  "EARN_HASTRA_DEX_EXIT_ENABLED",
  "JUPITER_SWAP_API_KEY",
  "WISDOMTREE_API_KEY",
  "WISDOMTREE_SANDBOX_API_KEY",
  "MARKETS_ENABLED",
  "EARN_ENABLED",
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
    ...EARN_ENABLED_FLAGS,
  });
}

async function disablePrivyEntitlement(): Promise<void> {
  await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
    JSON.stringify({ providerOverrides: { custody: { privy: false } } }),
    TEST_ORG_ID,
  ]);
}

function admitCustodySetup(
  project: SeededProject,
  provider: CustodyProvider,
  mode: CustodyMode
): Promise<void> {
  return assertCustodySetupAdmitted(env, getDb(env), {
    organizationId: project.organizationId,
    projectId: project.id,
    provider,
    mode,
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
    vi.restoreAllMocks();
    writeProviderEnv(originalProviderEnv);
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
  });

  it("logs an attributable custody entitlement denial without changing its 403 response", async () => {
    const logger = getLogger();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    await expect(
      assertCustodyProviderEntitled(env, getDb(env), TEST_ORG_ID, "privy")
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
      JSON.stringify({ providerOverrides: { custody: { privy: false } } }),
      TEST_ORG_ID,
    ]);
    await expect(
      assertCustodyProviderEntitled(env, getDb(env), TEST_ORG_ID, "privy")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      details: { reason: "provider_not_entitled" },
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "sdp_api_custody_entitlement_denied",
        organization_id: TEST_ORG_ID,
        provider: "privy",
        reason: "provider_not_entitled",
      },
      "sdp_api_custody_entitlement_denied"
    );
    warn.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await expect(
      assertCustodyProviderEntitled(env, getDb(env), TEST_ORG_ID, "privy")
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("resolves general defaults independently of the legacy tier value", () => {
    const resolved = resolveOrganizationProviderEntitlements({
      tier: "individual",
      providerOverrides: {
        custody: {
          local: true,
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
    expect(resolved.providers.compliance.range).toBe(true);
    expect(resolved.providers.ramps.moonpay).toBe(true);
    expect(resolved.providers.ramps.lightspark).toBe(true);
  });

  it("marks providers available only when the organization is entitled and the environment is configured", async () => {
    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    expect(availability.tier).toBe("individual");
    expect(availability.providers.custody.privy).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(availability.providers.custody.coinbase_cdp.enabled).toBe(true);
    expect(availability.providers.custody.turnkey.enabled).toBe(true);
    expect(availability.providers.custody.para.enabled).toBe(true);
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

  it("admits an organization's enabled custody provider", async () => {
    await expect(
      assertCustodyProviderEnabled(env, getDb(env), TEST_ORG_ID, "privy")
    ).resolves.toBeUndefined();
  });

  it("explains when a configured custody provider is not entitled for the organization", async () => {
    await disablePrivyEntitlement();

    await expect(
      assertCustodyProviderEnabled(env, getDb(env), TEST_ORG_ID, "privy")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      message: "Privy requires manual activation for this organization.",
    });
  });

  it("explains when an entitled custody provider is not configured in the deployment", async () => {
    env.PRIVY_APP_SECRET = undefined;

    await expect(
      assertCustodyProviderEnabled(env, getDb(env), TEST_ORG_ID, "privy")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
      message: "Privy is not configured in this environment.",
    });
  });

  it("reports providers the release channel leaves out as not enabled", async () => {
    await setOrganizationTier("enterprise");

    const onExperimental = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );
    const onStable = await getProviderAvailability(
      { ...env, SDP_RELEASE_CHANNEL: "stable" },
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    const enabledRamps = RAMP_PROVIDERS.filter((p) => onExperimental.providers.ramps[p]?.enabled);
    expect(enabledRamps.length).toBeGreaterThan(0);
    for (const provider of enabledRamps) {
      expect(onStable.providers.ramps[provider]).toEqual({
        ...onExperimental.providers.ramps[provider],
        enabled: false,
      });
    }
    for (const provider of EARN_PROVIDERS) {
      if (!onExperimental.providers.earn[provider]?.enabled) continue;
      expect(onStable.providers.earn[provider]?.enabled).toBe(false);
    }
    // Stable modules are unchanged.
    expect(onStable.providers.custody).toEqual(onExperimental.providers.custody);
    expect(onStable.providers.compliance).toEqual(onExperimental.providers.compliance);
  });

  it("follows injected ramp provider stages", async () => {
    await setOrganizationTier("enterprise");
    const onBeta = { ...env, SDP_RELEASE_CHANNEL: "beta" };
    const onExperimental = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );
    expect(onExperimental.providers.ramps.moonpay?.enabled).toBe(true);

    const availability = await getProviderAvailability(onBeta, getDb(env), TEST_ORG_ID, {
      rampProviderStages: { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" },
    });

    expect(availability.providers.ramps.moonpay?.enabled).toBe(true);
    expect(availability.providers.ramps.bvnk?.enabled).toBe(false);
  });

  it("treats partially configured multi-secret providers as not configured", async () => {
    await setOrganizationTier("enterprise");
    env.BVNK_WALLET_ID = "bvnk_wallet";
    env.BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
    env.BVNK_HAWK_SECRET_KEY = undefined;

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    expect(availability.providers.ramps.bvnk).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
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

    const withoutKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID, MANIFEST_STAGES);
    expect(withoutKey.providers.custody.local).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });

    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const managedWithKey = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );
    expect(managedWithKey.providers.custody.local).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });

    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    const selfHostedWithKey = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );
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
      },
    });
  });

  it("applies general defaults and metadata overrides uniformly to self-hosted orgs", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    expect(availability.tier).toBe("individual");
    expect(availability.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(availability.providers.custody.dfns).toEqual({
      entitled: false,
      configured: false,
      enabled: false,
    });
    expect(availability.providers.custody.ibm_haven).toEqual({
      entitled: false,
      configured: false,
      enabled: false,
    });
    expect(availability.providers.compliance.range.entitled).toBe(false);
    expect(availability.providers.ramps.lightspark.entitled).toBe(true);
    expect(availability.providers.ramps.bvnk.entitled).toBe(true);
  });

  it("honors a custody override disabling local the same way in self-hosted mode", async () => {
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

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    expect(availability.providers.custody.local).toEqual({
      entitled: false,
      configured: true,
      enabled: false,
    });
    expect(availability.providers.custody.privy.entitled).toBe(true);
  });

  it("applies general defaults when SDP_DEPLOYMENT_MODE is unset", async () => {
    env.SDP_DEPLOYMENT_MODE = undefined;
    env.CUSTODY_PRIVATE_KEY =
      "3QpWV8xk4hs7vmQhSLAQWNi2KskuSVSpmR75QGqSuxaKcdA9XJkq8VBihspJddBWVfEybTWLKqHJ19N64DNuwSNd";

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

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
          defaultEnvironment: "sandbox",
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
      defaultEnvironment: "sandbox",
    });
  });

  it("parseClerkOrganizationTierMetadata returns enableProductionProject true only for boolean true", () => {
    const cases: Array<{ metadata: unknown; expected: boolean }> = [
      { metadata: { sdp: { enableProductionProject: true } }, expected: true },
      { metadata: { sdp: { enableProductionProject: false } }, expected: false },
      { metadata: { sdp: { enableProductionProject: "true" } }, expected: false },
      { metadata: { sdp: { enableProductionProject: 1 } }, expected: false },
      { metadata: { sdp: {} }, expected: false },
      { metadata: {}, expected: false },
      { metadata: undefined, expected: false },
    ];

    for (const { metadata, expected } of cases) {
      expect(
        parseClerkOrganizationTierMetadata({
          id: "org_parse_test",
          private_metadata: metadata,
        }).enableProductionProject
      ).toBe(expected);
    }
  });

  it("parseProviderOverridesFromClerkMetadata drops a stale rpc family and keeps the families it knows", () => {
    expect(
      parseProviderOverridesFromClerkMetadata({
        rpc: { helius: true },
        custody: { privy: true },
      })
    ).toEqual({ custody: { privy: true } });
    expect(parseProviderOverridesFromClerkMetadata({ rpc: { helius: true } })).toBeUndefined();
  });

  it("syncs enableProductionProject into settings when true and strips it when absent, preserving unrelated keys", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          defaultEnvironment: "sandbox",
          enableProductionProject: true,
        }),
        TEST_ORG_ID
      )
      .run();

    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_strip_test",
        private_metadata: {},
      },
    });

    const stripped = await getDb(env)
      .prepare("SELECT settings FROM organizations WHERE id = ?")
      .bind(TEST_ORG_ID)
      .first<{ settings: string | null }>();
    expect(stripped?.settings ? JSON.parse(stripped.settings) : null).toEqual({
      defaultEnvironment: "sandbox",
    });
  });

  it("syncs enableProductionProject and collapses settings to null when nothing remains", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ enableProductionProject: true }), TEST_ORG_ID)
      .run();

    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_collapse_test",
        private_metadata: {},
      },
    });

    const collapsed = await getDb(env)
      .prepare("SELECT settings FROM organizations WHERE id = ?")
      .bind(TEST_ORG_ID)
      .first<{ settings: string | null }>();
    expect(collapsed?.settings).toBeNull();
  });

  it("syncs enableProductionProject true alongside provider overrides", async () => {
    await syncProviderAccessFromClerk(getDb(env), {
      organizationId: TEST_ORG_ID,
      clerkOrganization: {
        id: "org_clerk_combined_test",
        private_metadata: {
          sdp: {
            enableProductionProject: true,
            providerOverrides: {
              custody: { local: true },
            },
          },
        },
      },
    });

    const combined = await getDb(env)
      .prepare("SELECT settings FROM organizations WHERE id = ?")
      .bind(TEST_ORG_ID)
      .first<{ settings: string | null }>();
    expect(combined?.settings ? JSON.parse(combined.settings) : null).toEqual({
      enableProductionProject: true,
      providerOverrides: { custody: { local: true } },
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
      kamino: false,
      jupiter_lend: false,
      ondo: false,
      hastra: false,
      wisdomtree: false,
    });
  });

  it("reports earn provider availability from override entitlement plus configured credentials", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { upshift: true } } }), TEST_ORG_ID)
      .run();
    env.UPSHIFT_API_KEY = "upshift_test_key";

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

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

  it.for(EARN_FLAG_OFF_CASES)(
    "reports an entitled, configured earn provider as not enabled while $flag is off",
    async ({ flags }) => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ providerOverrides: { earn: { upshift: true } } }), TEST_ORG_ID)
        .run();
      env.UPSHIFT_API_KEY = "upshift_test_key";

      const availability = await getProviderAvailability(
        { ...env, ...flags },
        getDb(env),
        TEST_ORG_ID,
        MANIFEST_STAGES
      );

      expect(availability.providers.earn.upshift).toEqual({
        entitled: true,
        configured: true,
        enabled: false,
      });
    }
  );

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

    const availability = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );

    expect(availability.providers.earn.veda).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
  });

  /**
   * Ondo holds no credential of its own, but every deposit and exit it builds
   * is a Jupiter swap, so readiness follows the PLATFORM swap key. Reporting
   * `configured: true` without it would offer an entitled organization a
   * deposit action that fails at build time (Greptile on #1810).
   */
  it("reports Ondo configured only when the platform Jupiter swap key is set", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { ondo: true } } }), TEST_ORG_ID)
      .run();

    env.JUPITER_SWAP_API_KEY = undefined;
    const without = await getProviderAvailability(env, getDb(env), TEST_ORG_ID, MANIFEST_STAGES);
    expect(without.providers.earn.ondo).toEqual({
      entitled: true,
      configured: false,
      enabled: false,
    });
    expect(() => assertEarnProviderConfigured(env, "ondo", false)).toThrow(
      "Ondo is not configured for production mode."
    );

    env.JUPITER_SWAP_API_KEY = "jup_test_key";
    const withKey = await getProviderAvailability(env, getDb(env), TEST_ORG_ID, MANIFEST_STAGES);
    expect(withKey.providers.earn.ondo).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    // One key serves both modes: Jupiter has no sandbox tenant to select.
    expect(() => assertEarnProviderConfigured(env, "ondo", true)).not.toThrow();
  });

  it("keeps Hastra configured for keyless deposits and par redemption", async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { earn: { hastra: true } } }), TEST_ORG_ID)
      .run();

    env.JUPITER_SWAP_API_KEY = undefined;
    env.EARN_HASTRA_DEX_EXIT_ENABLED = undefined;
    const without = await getProviderAvailability(env, getDb(env), TEST_ORG_ID, MANIFEST_STAGES);
    expect(without.providers.earn.hastra).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
    });
    expect(() => assertEarnProviderConfigured(env, "hastra", false)).not.toThrow();

    // Enabling the optional DEX rail without its Jupiter prerequisite must not
    // disable the native provider. The rail's resolver fails closed instead.
    env.EARN_HASTRA_DEX_EXIT_ENABLED = "true";
    const dexMisconfigured = await getProviderAvailability(
      env,
      getDb(env),
      TEST_ORG_ID,
      MANIFEST_STAGES
    );
    expect(dexMisconfigured.providers.earn.hastra).toEqual({
      entitled: true,
      configured: true,
      enabled: true,
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

  describe("custody setup admission", () => {
    let projects: SeededDefaultProjects;

    beforeEach(async () => {
      custodyReleaseChannel.outOfChannelMode = null;
      custodyReleaseChannel.stageOverride = null;
      await getDb(env).execute(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'provider-availability-test@example.com', 1, 'active')`,
        [TEST_USER_ID]
      );
      projects = await seedDefaultProjects(getDb(env), {
        organizationId: TEST_ORG_ID,
        createdBy: TEST_USER_ID,
        members: [],
      });
    });

    it("admits Managed and BYOK Privy in a Sandbox project", async () => {
      await expect(
        admitCustodySetup(projects.sandbox, "privy", "managed")
      ).resolves.toBeUndefined();
      await expect(admitCustodySetup(projects.sandbox, "privy", "byok")).resolves.toBeUndefined();
    });

    it("admits only BYOK Privy in a Production project and logs the Managed refusal", async () => {
      const logger = getLogger();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

      await expect(
        admitCustodySetup(projects.production, "privy", "byok")
      ).resolves.toBeUndefined();
      await expect(
        admitCustodySetup(projects.production, "privy", "managed")
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        statusCode: 403,
        message: "Privy Managed custody is not allowed in a production project.",
        details: { reason: "custody_mode_not_allowed" },
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          event: "sdp_api_project_provider_refused",
          organization_id: TEST_ORG_ID,
          project_id: projects.production.id,
          environment: "production",
          family: "custody",
          provider: "privy",
          mode: "managed",
          reason: "custody_mode_not_allowed",
        },
        "sdp_api_project_provider_refused"
      );
    });

    it("refuses a pair outside the release channel before the Production mode check", async () => {
      custodyReleaseChannel.outOfChannelMode = "managed";

      await expect(
        admitCustodySetup(projects.production, "privy", "managed")
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        statusCode: 403,
        message: custodyProviderNotInReleaseChannel("privy", "managed").message,
        details: { reason: "custody_provider_not_in_release_channel" },
      });
    });

    it("admits a below-stable BYOK pair the channel offers in both a Production and a Sandbox project", async () => {
      custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };

      await expect(
        admitCustodySetup(projects.production, "privy", "byok")
      ).resolves.toBeUndefined();
      await expect(admitCustodySetup(projects.sandbox, "privy", "byok")).resolves.toBeUndefined();
    });

    it("refuses an unentitled provider after the Production mode check", async () => {
      await disablePrivyEntitlement();

      await expect(admitCustodySetup(projects.sandbox, "privy", "managed")).rejects.toMatchObject(
        NOT_ENTITLED_REFUSAL
      );
      await expect(admitCustodySetup(projects.production, "privy", "byok")).rejects.toMatchObject(
        NOT_ENTITLED_REFUSAL
      );
      await expect(
        admitCustodySetup(projects.production, "privy", "managed")
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: { reason: "custody_mode_not_allowed" },
      });
    });

    it("refuses Managed custody whose credentials the deployment lacks and admits BYOK without them", async () => {
      env.PRIVY_APP_ID = undefined;
      env.PRIVY_APP_SECRET = undefined;

      await expect(admitCustodySetup(projects.sandbox, "privy", "managed")).rejects.toMatchObject({
        code: "PROVIDER_NOT_CONFIGURED",
        statusCode: 503,
        message: "Privy is not configured for sandbox projects in this deployment.",
        details: { reason: "provider_not_configured" },
      });
      await expect(admitCustodySetup(projects.sandbox, "privy", "byok")).resolves.toBeUndefined();
    });

    it("admits BYOK completion in a Production project without deployment Privy credentials", async () => {
      env.PRIVY_APP_ID = undefined;
      env.PRIVY_APP_SECRET = undefined;

      await expect(
        admitByokCustodySetup(
          env,
          getDb(env),
          { organizationId: TEST_ORG_ID, projectId: projects.production.id },
          "privy"
        )
      ).resolves.toEqual({ admitted: true });
    });

    it("returns the gate's refusal for BYOK completion with its request and environment, without logging it", async () => {
      const logger = getLogger();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const project = { organizationId: TEST_ORG_ID, projectId: projects.production.id };

      const notInChannel = await admitByokCustodySetup(env, getDb(env), project, "turnkey");
      expect(notInChannel).toMatchObject({
        admitted: false,
        request: { ...project, provider: "turnkey", mode: "byok" },
        environment: "production",
        error: {
          code: "FORBIDDEN",
          statusCode: 403,
          message: custodyProviderNotInReleaseChannel("turnkey", "byok").message,
          details: { reason: "custody_provider_not_in_release_channel" },
        },
      });
      expect(notInChannel).toMatchObject({ error: expect.any(CustodySetupRefusedError) });

      await disablePrivyEntitlement();
      await expect(admitByokCustodySetup(env, getDb(env), project, "privy")).resolves.toMatchObject(
        {
          admitted: false,
          request: { ...project, provider: "privy", mode: "byok" },
          environment: "production",
          error: NOT_ENTITLED_REFUSAL,
        }
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("lists a Production project's admitted modes without logging the Managed refusal", async () => {
      const logger = getLogger();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const project = { organizationId: TEST_ORG_ID, projectId: projects.production.id };

      const availability = await getProjectProviderAvailability(env, getDb(env), project);
      expect(availability.providers).toContainEqual({
        family: "custody",
        provider: "privy",
        modes: ["byok"],
        unavailableModes: [{ mode: "managed", reason: "custody_mode_not_allowed" }],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(["sandbox", "production"] as const)(
      "treats an archived %s project as not found at every gate entry point, without logging",
      async (environment) => {
        const logger = getLogger();
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
        const project = projects[environment];
        await getDb(env)
          .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
          .bind(project.id)
          .run();
        const notFound = { code: "NOT_FOUND", statusCode: 404, message: "Project not found" };
        const scope = { organizationId: project.organizationId, projectId: project.id };

        await expect(admitCustodySetup(project, "privy", "byok")).rejects.toMatchObject(notFound);
        await expect(admitCustodySetup(project, "privy", "managed")).rejects.toMatchObject(
          notFound
        );
        await expect(admitByokCustodySetup(env, getDb(env), scope, "privy")).rejects.toMatchObject(
          notFound
        );
        await expect(getProjectProviderAvailability(env, getDb(env), scope)).rejects.toMatchObject(
          notFound
        );
        expect(warn).not.toHaveBeenCalled();
      }
    );
  });
});
