import {
  type ApiKeyRole,
  getPermissionsForApiKeyRole,
  type OrganizationProviderOverrides,
  type ProjectProviderAvailability,
  type SdpEnvironment,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { seedProjectApiKey, type TestApiKeyMaterial } from "@/test/helpers/api-keys";
import { clerkHeadersWithoutProject } from "@/test/helpers/clerk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { EARN_ENABLED_FLAGS, EARN_FLAG_OFF_CASES } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { type SeededDefaultProjects, seedDefaultProjects } from "@/test/helpers/projects";
import { providerStages } from "@/test/helpers/provider-stages";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@sdp/types", async (importOriginal) => {
  const { mockProviderStages } = await import("@/test/helpers/provider-stages");
  return mockProviderStages(await importOriginal<typeof import("@sdp/types")>());
});

const ORGANIZATION_ID = "org_project_provider_availability";
const USER_ID = "usr_project_provider_availability";
const OTHER_ORGANIZATION_ID = "org_project_provider_availability_other";
const OTHER_USER_ID = "usr_project_provider_availability_other";
const PROJECT_IDS = {
  sandbox: "prj_project_provider_availability_sandbox",
  production: "prj_project_provider_availability_production",
} as const satisfies Record<SdpEnvironment, string>;
const API_KEYS = {
  sandbox: {
    id: "key_project_provider_availability_sandbox",
    raw: "sk_test_project_provider_availability",
    prefix: "sk_test_ppa",
  },
  production: {
    id: "key_project_provider_availability_production",
    raw: "sk_live_project_provider_availability",
    prefix: "sk_live_ppa",
  },
} as const satisfies Record<SdpEnvironment, TestApiKeyMaterial>;
const ROLE_API_KEYS = {
  api_admin: {
    role: "api_admin",
    id: "key_project_provider_availability_admin",
    raw: "sk_test_project_provider_availability_admin",
    prefix: "sk_test_ppaa",
  },
  api_developer: {
    role: "api_developer",
    id: "key_project_provider_availability_developer",
    raw: "sk_test_project_provider_availability_developer",
    prefix: "sk_test_ppad",
  },
  api_readonly: {
    role: "api_readonly",
    id: "key_project_provider_availability_readonly",
    raw: "sk_test_project_provider_availability_readonly",
    prefix: "sk_test_ppar",
  },
} as const satisfies { [Role in ApiKeyRole]: TestApiKeyMaterial & { role: Role } };
const FIXTURE_PROVIDER_OVERRIDES: OrganizationProviderOverrides = {
  compliance: { range: true },
  earn: { veda: true },
};
const DEPLOYMENT_CREDENTIALS = {
  PRIVY_APP_ID: "privy_project_provider_availability_app",
  PRIVY_APP_SECRET: "privy_project_provider_availability_secret",
  RANGE_API_KEY: "range_project_provider_availability_key",
  MOONPAY_API_KEY: "moonpay_project_provider_availability_key",
  MOONPAY_SECRET_KEY: "moonpay_project_provider_availability_secret",
  MOONPAY_SANDBOX_API_KEY: "moonpay_sandbox_project_provider_availability_key",
  MOONPAY_SANDBOX_SECRET_KEY: "moonpay_sandbox_project_provider_availability_secret",
  STRIPE_SECRET_KEY: "stripe_project_provider_availability_secret",
  STRIPE_PUBLISHABLE_KEY: "stripe_project_provider_availability_publishable",
  STRIPE_WEBHOOK_SECRET: "stripe_project_provider_availability_webhook",
} as const satisfies Partial<Env>;
const SANDBOX_AVAILABILITY: ProjectProviderAvailability = {
  projectId: PROJECT_IDS.sandbox,
  environment: "sandbox",
  providers: [
    { family: "custody", provider: "local", modes: [] },
    { family: "custody", provider: "fireblocks", modes: [] },
    { family: "custody", provider: "privy", modes: ["managed", "byok"] },
    { family: "custody", provider: "coinbase_cdp", modes: [] },
    { family: "custody", provider: "para", modes: [] },
    { family: "custody", provider: "turnkey", modes: [] },
    { family: "custody", provider: "dfns", modes: [] },
    { family: "custody", provider: "ibm_haven", modes: [] },
    { family: "custody", provider: "anchorage", modes: [] },
    { family: "custody", provider: "utila", modes: [] },
    { family: "compliance", provider: "range", available: true },
    { family: "compliance", provider: "elliptic", available: false },
    { family: "compliance", provider: "trm", available: false },
    { family: "compliance", provider: "chainalysis", available: false },
    { family: "ramps", provider: "moonpay", available: true },
    { family: "ramps", provider: "lightspark", available: false },
    { family: "ramps", provider: "bvnk", available: false },
    { family: "ramps", provider: "moneygram", available: false },
    { family: "ramps", provider: "coinbase", available: false },
    { family: "ramps", provider: "mural", available: false },
    { family: "ramps", provider: "stripe", available: true },
    { family: "earn", provider: "veda", available: true },
    { family: "earn", provider: "upshift", available: false },
    { family: "earn", provider: "perena", available: false },
    { family: "earn", provider: "kamino", available: false },
    { family: "earn", provider: "jupiter_lend", available: false },
    { family: "earn", provider: "ondo", available: false },
    { family: "earn", provider: "hastra", available: false },
    { family: "earn", provider: "wisdomtree", available: false },
  ],
};
const PRODUCTION_AVAILABILITY: ProjectProviderAvailability = {
  projectId: PROJECT_IDS.production,
  environment: "production",
  providers: [
    { family: "custody", provider: "local", modes: [] },
    { family: "custody", provider: "fireblocks", modes: [] },
    { family: "custody", provider: "privy", modes: ["byok"] },
    { family: "custody", provider: "coinbase_cdp", modes: [] },
    { family: "custody", provider: "para", modes: [] },
    { family: "custody", provider: "turnkey", modes: [] },
    { family: "custody", provider: "dfns", modes: [] },
    { family: "custody", provider: "ibm_haven", modes: [] },
    { family: "custody", provider: "anchorage", modes: [] },
    { family: "custody", provider: "utila", modes: [] },
    { family: "compliance", provider: "range", available: true },
    { family: "compliance", provider: "elliptic", available: false },
    { family: "compliance", provider: "trm", available: false },
    { family: "compliance", provider: "chainalysis", available: false },
    { family: "ramps", provider: "moonpay", available: true },
    { family: "ramps", provider: "lightspark", available: false },
    { family: "ramps", provider: "bvnk", available: false },
    { family: "ramps", provider: "moneygram", available: false },
    { family: "ramps", provider: "coinbase", available: false },
    { family: "ramps", provider: "mural", available: false },
    { family: "ramps", provider: "stripe", available: true },
    { family: "earn", provider: "veda", available: true },
    { family: "earn", provider: "upshift", available: false },
    { family: "earn", provider: "perena", available: false },
    { family: "earn", provider: "kamino", available: false },
    { family: "earn", provider: "jupiter_lend", available: false },
    { family: "earn", provider: "ondo", available: false },
    { family: "earn", provider: "hastra", available: false },
    { family: "earn", provider: "wisdomtree", available: false },
  ],
};
const PROJECT_NOT_FOUND_BODY = {
  error: { code: "NOT_FOUND", message: "Project not found" },
  meta: { requestId: expect.any(String) },
};

let otherProjects: SeededDefaultProjects;

function deploymentEnv(overrides: Partial<Env>): Env {
  return { ...env, ...DEPLOYMENT_CREDENTIALS, ...EARN_ENABLED_FLAGS, ...overrides };
}

function apiKeyHeaders(key: TestApiKeyMaterial): Record<string, string> {
  return { Authorization: `Bearer ${key.raw}` };
}

function read(
  projectId: string,
  headers: Record<string, string>,
  deployment: Env
): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/projects/${projectId}/provider-availability`, { headers }, deployment)
  );
}

async function readAvailability(
  environment: SdpEnvironment,
  deployment: Env
): Promise<ProjectProviderAvailability> {
  const response = await read(
    PROJECT_IDS[environment],
    apiKeyHeaders(API_KEYS[environment]),
    deployment
  );
  expect(response.status).toBe(200);
  const body: { data: ProjectProviderAvailability } = await response.json();
  return body.data;
}

function availabilityBody(availability: ProjectProviderAvailability) {
  return {
    data: availability,
    meta: { requestId: expect.any(String), timestamp: expect.any(String) },
  };
}

async function setProviderOverrides(overrides: OrganizationProviderOverrides): Promise<void> {
  await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
    JSON.stringify({ providerOverrides: overrides }),
    ORGANIZATION_ID,
  ]);
}

async function seedApiKey(
  key: TestApiKeyMaterial,
  role: ApiKeyRole,
  environment: SdpEnvironment
): Promise<void> {
  const permissions = getPermissionsForApiKeyRole(role);
  const keyHash = await seedProjectApiKey(getDb(env), env, {
    key,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    createdBy: USER_ID,
    role,
    permissions,
  });
  await seedCachedApiKey(env, keyHash, {
    id: key.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    role,
    permissions,
    environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  });
}

async function seedOrganization(organizationId: string, userId: string): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, ?, ?, 'individual', 'active')`,
    [organizationId, organizationId, organizationId.replaceAll("_", "-")]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, ?, 1, 'active')`,
    [userId, `${userId}@example.com`]
  );
  await db.execute(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES (?, ?, ?, 'admin', 'active')`,
    [`mem_${userId}`, organizationId, userId]
  );
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  await seedOrganization(ORGANIZATION_ID, USER_ID);
  await seedOrganization(OTHER_ORGANIZATION_ID, OTHER_USER_ID);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: PROJECT_IDS,
  });
  otherProjects = await seedDefaultProjects(db, {
    organizationId: OTHER_ORGANIZATION_ID,
    createdBy: OTHER_USER_ID,
    members: [OTHER_USER_ID],
  });
  await setProviderOverrides(FIXTURE_PROVIDER_OVERRIDES);
  await seedApiKey(API_KEYS.sandbox, "api_admin", "sandbox");
  await seedApiKey(API_KEYS.production, "api_admin", "production");
}

describe("GET /v1/projects/:projectId/provider-availability", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    custodyReleaseChannel.stageOverride = null;
    providerStages.moduleStageOverride = null;
    providerStages.surfacedEarnProvider = null;
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("lists every provider with its availability for a Sandbox project", async () => {
    const response = await read(
      PROJECT_IDS.sandbox,
      apiKeyHeaders(API_KEYS.sandbox),
      deploymentEnv({})
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(availabilityBody(SANDBOX_AVAILABILITY));
  });

  it("lists every provider with its availability for a Production project", async () => {
    const response = await read(
      PROJECT_IDS.production,
      apiKeyHeaders(API_KEYS.production),
      deploymentEnv({})
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(availabilityBody(PRODUCTION_AVAILABILITY));
  });

  it("reports providers the release channel leaves out as unavailable", async () => {
    custodyReleaseChannel.outOfChannelMode = "managed";
    providerStages.moduleStageOverride = { module: "compliance", stage: "experimental" };

    const availability = await readAvailability(
      "sandbox",
      deploymentEnv({ SDP_RELEASE_CHANNEL: "beta" })
    );

    expect(availability.providers).toContainEqual({
      family: "custody",
      provider: "privy",
      modes: ["byok"],
    });
    expect(availability.providers).toContainEqual({
      family: "compliance",
      provider: "range",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "ramps",
      provider: "moonpay",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "earn",
      provider: "veda",
      available: false,
    });
  });

  it.for(EARN_FLAG_OFF_CASES)(
    "reports every Earn provider as unavailable while $flag is off",
    async ({ flags }) => {
      const availability = await readAvailability("sandbox", deploymentEnv(flags));

      expect(availability).toEqual({
        ...SANDBOX_AVAILABILITY,
        providers: SANDBOX_AVAILABILITY.providers.map((entry) =>
          entry.family === "earn" ? { ...entry, available: false } : entry
        ),
      });
    }
  );

  it("reports providers the organization is not entitled to as unavailable", async () => {
    await setProviderOverrides({
      custody: { privy: false },
      compliance: { range: false },
      ramps: { moonpay: false },
      earn: { veda: false },
    });

    const availability = await readAvailability("sandbox", deploymentEnv({}));

    expect(availability.providers).toContainEqual({
      family: "custody",
      provider: "privy",
      modes: [],
    });
    expect(availability.providers).toContainEqual({
      family: "compliance",
      provider: "range",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "ramps",
      provider: "moonpay",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "earn",
      provider: "veda",
      available: false,
    });
  });

  it("reports below-stable providers the release channel offers the same in a Production project as in a Sandbox one, Managed custody aside", async () => {
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };
    providerStages.moduleStageOverride = { module: "compliance", stage: "beta" };

    const production = await readAvailability("production", deploymentEnv({}));
    const sandbox = await readAvailability("sandbox", deploymentEnv({}));

    expect(production.providers.filter((entry) => entry.family !== "custody")).toEqual(
      SANDBOX_AVAILABILITY.providers.filter((entry) => entry.family !== "custody")
    );
    expect(sandbox.providers.filter((entry) => entry.family !== "custody")).toEqual(
      SANDBOX_AVAILABILITY.providers.filter((entry) => entry.family !== "custody")
    );
    expect(production.providers).toContainEqual({
      family: "custody",
      provider: "privy",
      modes: ["byok"],
    });
    expect(sandbox.providers).toContainEqual({
      family: "custody",
      provider: "privy",
      modes: ["managed", "byok"],
    });
  });

  it("reports providers the deployment holds no credentials for as unavailable, except BYOK custody", async () => {
    providerStages.surfacedEarnProvider = "upshift";
    await setProviderOverrides({
      ...FIXTURE_PROVIDER_OVERRIDES,
      earn: { veda: true, upshift: true },
    });
    const unconfigured = deploymentEnv({
      PRIVY_APP_ID: undefined,
      PRIVY_APP_SECRET: undefined,
      RANGE_API_KEY: undefined,
      MOONPAY_SANDBOX_API_KEY: undefined,
      MOONPAY_SANDBOX_SECRET_KEY: undefined,
    });

    const availability = await readAvailability("sandbox", unconfigured);
    const withUpshiftKey = await readAvailability("sandbox", {
      ...unconfigured,
      UPSHIFT_SANDBOX_API_KEY: "upshift_sandbox_project_provider_availability_key",
    });

    expect(availability.providers).toContainEqual({
      family: "custody",
      provider: "privy",
      modes: ["byok"],
    });
    expect(availability.providers).toContainEqual({
      family: "compliance",
      provider: "range",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "ramps",
      provider: "moonpay",
      available: false,
    });
    expect(availability.providers).toContainEqual({
      family: "earn",
      provider: "upshift",
      available: false,
    });
    expect(withUpshiftKey.providers).toContainEqual({
      family: "earn",
      provider: "upshift",
      available: true,
    });
  });

  it("reports a provider with only sandbox credentials as unavailable in a Production project", async () => {
    const sandboxKeysOnly = deploymentEnv({
      MOONPAY_API_KEY: undefined,
      MOONPAY_SECRET_KEY: undefined,
    });

    const production = await readAvailability("production", sandboxKeysOnly);
    const sandbox = await readAvailability("sandbox", sandboxKeysOnly);

    expect(production.providers).toContainEqual({
      family: "ramps",
      provider: "moonpay",
      available: false,
    });
    expect(sandbox.providers).toContainEqual({
      family: "ramps",
      provider: "moonpay",
      available: true,
    });
  });

  it.for(Object.values(ROLE_API_KEYS))("serves an $role key bound to the project", async (key) => {
    await seedApiKey(key, key.role, "sandbox");

    const response = await read(PROJECT_IDS.sandbox, apiKeyHeaders(key), deploymentEnv({}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(availabilityBody(SANDBOX_AVAILABILITY));
  });

  it("serves a dashboard session of the project's organization", async () => {
    const token = await signSeededClerkMember(env, getDb(env), USER_ID, ORGANIZATION_ID);

    const response = await read(
      PROJECT_IDS.sandbox,
      clerkHeadersWithoutProject(token),
      deploymentEnv({})
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(availabilityBody(SANDBOX_AVAILABILITY));
  });

  it("returns 404 to an API key for another organization's project", async () => {
    const response = await read(
      otherProjects.sandbox.id,
      apiKeyHeaders(API_KEYS.sandbox),
      deploymentEnv({})
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(PROJECT_NOT_FOUND_BODY);
  });

  it("returns 404 to a dashboard session of another organization", async () => {
    const token = await signSeededClerkMember(
      env,
      getDb(env),
      OTHER_USER_ID,
      OTHER_ORGANIZATION_ID
    );

    const response = await read(
      PROJECT_IDS.sandbox,
      clerkHeadersWithoutProject(token),
      deploymentEnv({})
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(PROJECT_NOT_FOUND_BODY);
  });

  it("returns 401 without credentials", async () => {
    const response = await read(
      PROJECT_IDS.sandbox,
      { "x-forwarded-for": "10.2.0.1" },
      deploymentEnv({})
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "API key required" },
      meta: { requestId: expect.any(String) },
    });
  });
});
