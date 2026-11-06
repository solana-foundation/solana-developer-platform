import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  CUSTODY_CONFIG_STATUSES,
  CUSTODY_CONNECTION_LIFECYCLES,
  type CustodyConfigStatus,
  type CustodyConnectionLifecycle,
} from "@sdp/types/custody";
import type {
  CustodyIntegration,
  IntegrationFamily,
  ProjectIntegrations,
} from "@sdp/types/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { seedProjectApiKey, type TestApiKeyMaterial } from "@/test/helpers/api-keys";
import { clerkHeaders } from "@/test/helpers/clerk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { insertTestCustodyConfigRow } from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  seedUnreadPrivyWallet,
  type TestCustodyConnection,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

type InactiveConnectionLifecycle = Exclude<CustodyConnectionLifecycle, "active">;

const ORGANIZATION_ID = "org_hoo2662_integrations";
const MEMBER = organizationMember("hoo2662_integrations", "admin");
const PROJECT_IDS = {
  sandbox: "prj_hoo2662_sandbox",
  production: "prj_hoo2662_production",
} as const satisfies Record<SdpEnvironment, string>;
const API_KEYS = {
  sandbox: { id: "key_hoo2662_sandbox", raw: "sk_test_hoo2662_sandbox", prefix: "sk_test_h26" },
  production: {
    id: "key_hoo2662_production",
    raw: "sk_live_hoo2662_production",
    prefix: "sk_live_h26",
  },
} as const satisfies Record<SdpEnvironment, TestApiKeyMaterial>;
const SEEDED_AT = "2026-11-01T00:00:00.000Z";
const DEPLOYMENT: Env = {
  ...env,
  PRIVY_APP_ID: "privy_hoo2662_app",
  PRIVY_APP_SECRET: "privy_hoo2662_secret",
  PARA_API_KEY: "para_hoo2662_key",
};
const INACTIVE_CONNECTION_LIFECYCLES = CUSTODY_CONNECTION_LIFECYCLES.filter(
  (status): status is InactiveConnectionLifecycle => status !== "active"
);
const INACTIVE_CONFIG_STATUSES = CUSTODY_CONFIG_STATUSES.filter((status) => status !== "active");
const INACTIVE_CONNECTION_CHECKS = {
  pending: {
    lastCheckStatus: null,
    lastCheckAt: null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
  },
  checking: {
    lastCheckStatus: "running",
    lastCheckAt: SEEDED_AT,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
  },
  failed: {
    lastCheckStatus: "failed",
    lastCheckAt: SEEDED_AT,
    lastCheckFailureCode: "invalid_credentials",
    activatedAt: null,
    deactivatedAt: null,
  },
  deactivated: {
    lastCheckStatus: "success",
    lastCheckAt: SEEDED_AT,
    lastCheckFailureCode: null,
    activatedAt: SEEDED_AT,
    deactivatedAt: SEEDED_AT,
  },
} as const satisfies Record<
  InactiveConnectionLifecycle,
  Pick<
    TestCustodyConnection,
    "lastCheckStatus" | "lastCheckAt" | "lastCheckFailureCode" | "activatedAt" | "deactivatedAt"
  >
>;
const SANDBOX_PRIVY_NOT_CONFIGURED: CustodyIntegration = {
  provider: "privy",
  category: "server",
  state: { status: "not_configured", modes: ["managed", "byok"] },
};
const SANDBOX_PARA_NOT_CONFIGURED: CustodyIntegration = {
  provider: "para",
  category: "server",
  state: { status: "not_configured", modes: ["managed"] },
};

function custodyFamily(integrations: CustodyIntegration[]): IntegrationFamily {
  return { family: "custody", integrations };
}

function privyIn(state: CustodyIntegration["state"]): CustodyIntegration {
  return { provider: "privy", category: "server", state };
}

async function readAs(
  headers: Record<string, string>,
  deployment: Env
): Promise<ProjectIntegrations> {
  const response = await app.request("/v1/integrations", { headers }, deployment);
  expect(response.status).toBe(200);
  const body: { data: ProjectIntegrations } = await response.json();
  return body.data;
}

async function readFamilies(environment: SdpEnvironment, deployment: Env) {
  const integrations = await readAs(
    { Authorization: `Bearer ${API_KEYS[environment].raw}` },
    deployment
  );
  return integrations.families;
}

async function seedActivePrivyConnection(environment: SdpEnvironment): Promise<void> {
  await seedUnreadPrivyWallet(getDb(env), {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    createdBy: MEMBER.userId,
    custodyWalletId: `cwlt_hoo2662_${environment}`,
    walletId: `privy_hoo2662_${environment}`,
    publicKey: "11111111111111111111111111111111",
  });
}

async function seedSandboxPrivyConfig(status: CustodyConfigStatus): Promise<void> {
  await insertTestCustodyConfigRow(getDb(env), {
    id: "cust_hoo2662_privy",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS.sandbox,
    provider: "privy",
    configEncrypted: "not-read",
    status,
  });
}

async function seedSandboxPrivyConnection(status: InactiveConnectionLifecycle): Promise<void> {
  const db = getDb(env);
  const credential = { id: "pcred_hoo2662_sandbox", projectId: PROJECT_IDS.sandbox };
  await insertTestStoredProviderCredential(db, {
    ...credential,
    organizationId: ORGANIZATION_ID,
    provider: "privy",
    label: "Privy",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "not-read" },
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: MEMBER.userId,
  });
  await insertTestCustodyConnection(db, {
    ...INACTIVE_CONNECTION_CHECKS[status],
    id: "cconn_hoo2662_sandbox",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS.sandbox,
    provider: "privy",
    credential,
    status,
    setupMetadata: {},
    providerAccountFingerprint: "sha256:hoo2662_sandbox",
    createdBy: MEMBER.userId,
    createdAt: SEEDED_AT,
  });
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  await seedOrganizationMembers(db, {
    organization: { id: ORGANIZATION_ID, slug: "hoo2662-integrations" },
    members: [MEMBER],
  });
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: MEMBER.userId,
    members: [MEMBER.userId],
    ids: PROJECT_IDS,
  });
  for (const environment of ["sandbox", "production"] as const) {
    await seedProjectApiKey(db, env, {
      key: API_KEYS[environment],
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS[environment],
      createdBy: MEMBER.userId,
      grants: ALL_API_KEY_GRANTS,
    });
  }
}

describe("GET /v1/integrations", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("returns the x-project-id project's integrations to a dashboard session, BYOK Privy connected", async () => {
    await seedActivePrivyConnection("production");
    const token = await signSeededClerkMember(env, getDb(env), MEMBER.userId, ORGANIZATION_ID);

    const response = await app.request(
      "/v1/integrations",
      { headers: clerkHeaders(token, PROJECT_IDS.production) },
      DEPLOYMENT
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        projectId: PROJECT_IDS.production,
        environment: "production",
        families: [
          {
            family: "custody",
            integrations: [
              {
                provider: "privy",
                category: "server",
                state: { status: "connected", mode: "byok" },
              },
            ],
          },
        ],
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it.each<{ environment: SdpEnvironment; integrations: CustodyIntegration[] }>([
    {
      environment: "sandbox",
      integrations: [SANDBOX_PRIVY_NOT_CONFIGURED, SANDBOX_PARA_NOT_CONFIGURED],
    },
    {
      environment: "production",
      integrations: [privyIn({ status: "not_configured", modes: ["byok"] })],
    },
  ])(
    "lists unset custody providers with the modes a $environment project allows",
    async ({ environment, integrations }) => {
      expect(await readFamilies(environment, DEPLOYMENT)).toEqual([custodyFamily(integrations)]);
    }
  );

  it("reports an active managed config as connected managed", async () => {
    await seedSandboxPrivyConfig("active");

    expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
      custodyFamily([
        privyIn({ status: "connected", mode: "managed" }),
        SANDBOX_PARA_NOT_CONFIGURED,
      ]),
    ]);
  });

  it("reports BYOK when the project holds both an active managed config and an active connection", async () => {
    await seedSandboxPrivyConfig("active");
    await seedActivePrivyConnection("sandbox");

    expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
      custodyFamily([privyIn({ status: "connected", mode: "byok" }), SANDBOX_PARA_NOT_CONFIGURED]),
    ]);
  });

  it.each(INACTIVE_CONNECTION_LIFECYCLES)(
    "leaves Privy not configured while its only connection is %s",
    async (status) => {
      await seedSandboxPrivyConnection(status);

      expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
        custodyFamily([SANDBOX_PRIVY_NOT_CONFIGURED, SANDBOX_PARA_NOT_CONFIGURED]),
      ]);
    }
  );

  it.each(INACTIVE_CONFIG_STATUSES)(
    "leaves Privy not configured while its only managed config is %s",
    async (status) => {
      await seedSandboxPrivyConfig(status);

      expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
        custodyFamily([SANDBOX_PRIVY_NOT_CONFIGURED, SANDBOX_PARA_NOT_CONFIGURED]),
      ]);
    }
  );

  it("omits custody providers the release channel leaves out", async () => {
    expect(await readFamilies("sandbox", { ...DEPLOYMENT, SDP_RELEASE_CHANNEL: "stable" })).toEqual(
      [custodyFamily([SANDBOX_PRIVY_NOT_CONFIGURED])]
    );
  });

  it("answers an API key with its own project's integrations, whatever x-project-id names", async () => {
    await seedActivePrivyConnection("production");

    const integrations = await readAs(
      {
        Authorization: `Bearer ${API_KEYS.sandbox.raw}`,
        "x-project-id": PROJECT_IDS.production,
      },
      DEPLOYMENT
    );

    expect(integrations).toEqual({
      projectId: PROJECT_IDS.sandbox,
      environment: "sandbox",
      families: [custodyFamily([SANDBOX_PRIVY_NOT_CONFIGURED, SANDBOX_PARA_NOT_CONFIGURED])],
    });
  });
});
