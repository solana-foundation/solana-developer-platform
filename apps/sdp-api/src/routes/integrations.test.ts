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
  IntegrationState,
  ProjectIntegrations,
} from "@sdp/types/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresPrivateChannelInstanceRepository } from "@/db/repositories/private-channel-instance.repository.postgres";
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
import { setOrganizationProviderOverrides } from "@/test/helpers/provider-overrides";
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
const SANDBOX_RAMP_AND_COMPLIANCE_CREDENTIALS = {
  MOONPAY_SANDBOX_API_KEY: "pk_test_hoo2662",
  MOONPAY_SANDBOX_SECRET_KEY: "sk_test_hoo2662",
  MOONPAY_SANDBOX_WEBHOOK_SECRET: "wk_test_hoo2662",
  STRIPE_SANDBOX_SECRET_KEY: "sk_test_hoo2662",
  STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_test_hoo2662",
  STRIPE_SANDBOX_WEBHOOK_SECRET: "whsec_hoo2662",
  RANGE_API_KEY: "range_hoo2662_key",
} as const satisfies Partial<Env>;
const RPC_POOL_URLS = {
  SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL: "https://solana-devnet.g.alchemy.com/v2/hoo2662-rpc-token",
  SOLANA_RPC_TRITON_DEVNET_API_KEY_URL: "https://hoo2662.devnet.rpcpool.com/hoo2662-rpc-token",
  SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL: "https://rpc.hoo2662.test/hoo2662-rpc-token",
  SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL:
    "https://hoo2662.solana-mainnet.quiknode.pro/hoo2662-rpc-token",
  SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL: "https://rpc.hoo2662.test/hoo2662-rpc-token",
} as const;
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

const PRIVATE_CHANNELS_NOT_CONFIGURED = privateChannelsFamily({
  status: "not_configured",
  modes: ["managed"],
});
const SANDBOX_UNSET_CUSTODY = custodyFamily([
  SANDBOX_PRIVY_NOT_CONFIGURED,
  SANDBOX_PARA_NOT_CONFIGURED,
]);

function custodyFamily(integrations: CustodyIntegration[]): IntegrationFamily {
  return { family: "custody", integrations };
}

function privateChannelsFamily(state: IntegrationState): IntegrationFamily {
  return { family: "private_channels", integrations: [{ provider: "private_channels", state }] };
}

function apiKeyHeaders(environment: SdpEnvironment): Record<string, string> {
  return { Authorization: `Bearer ${API_KEYS[environment].raw}` };
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
  const integrations = await readAs(apiKeyHeaders(environment), deployment);
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
    vi.unstubAllEnvs();
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
          {
            family: "private_channels",
            integrations: [
              {
                provider: "private_channels",
                state: { status: "not_configured", modes: ["managed"] },
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
      expect(await readFamilies(environment, DEPLOYMENT)).toEqual([
        custodyFamily(integrations),
        PRIVATE_CHANNELS_NOT_CONFIGURED,
      ]);
    }
  );

  it("reports an active managed config as connected managed", async () => {
    await seedSandboxPrivyConfig("active");

    expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
      custodyFamily([
        privyIn({ status: "connected", mode: "managed" }),
        SANDBOX_PARA_NOT_CONFIGURED,
      ]),
      PRIVATE_CHANNELS_NOT_CONFIGURED,
    ]);
  });

  it("reports BYOK when the project holds both an active managed config and an active connection", async () => {
    await seedSandboxPrivyConfig("active");
    await seedActivePrivyConnection("sandbox");

    expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
      custodyFamily([privyIn({ status: "connected", mode: "byok" }), SANDBOX_PARA_NOT_CONFIGURED]),
      PRIVATE_CHANNELS_NOT_CONFIGURED,
    ]);
  });

  it.each(INACTIVE_CONNECTION_LIFECYCLES)(
    "leaves Privy not configured while its only connection is %s",
    async (status) => {
      await seedSandboxPrivyConnection(status);

      expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
        SANDBOX_UNSET_CUSTODY,
        PRIVATE_CHANNELS_NOT_CONFIGURED,
      ]);
    }
  );

  it.each(INACTIVE_CONFIG_STATUSES)(
    "leaves Privy not configured while its only managed config is %s",
    async (status) => {
      await seedSandboxPrivyConfig(status);

      expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
        SANDBOX_UNSET_CUSTODY,
        PRIVATE_CHANNELS_NOT_CONFIGURED,
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
      { ...apiKeyHeaders("sandbox"), "x-project-id": PROJECT_IDS.production },
      DEPLOYMENT
    );

    expect(integrations).toEqual({
      projectId: PROJECT_IDS.sandbox,
      environment: "sandbox",
      families: [SANDBOX_UNSET_CUSTODY, PRIVATE_CHANNELS_NOT_CONFIGURED],
    });
  });

  it("reports the project's active Private Channels instance as connected managed", async () => {
    await createPostgresPrivateChannelInstanceRepository(getDb(env)).createActive({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS.sandbox,
      createdBy: MEMBER.userId,
      gatewayUrl: "https://gateway.hoo2662.test",
      chainRpcUrl: "",
      escrowProgramId: "prog_hoo2662_escrow",
      withdrawProgramId: "prog_hoo2662_withdraw",
      escrowInstanceAddr: "escrow_hoo2662",
      authUrl: "https://auth.hoo2662.test",
    });

    expect(await readFamilies("sandbox", DEPLOYMENT)).toEqual([
      SANDBOX_UNSET_CUSTODY,
      privateChannelsFamily({ status: "connected", mode: "managed" }),
    ]);
  });

  it("omits Private Channels on a release channel that does not run the module", async () => {
    expect(await readFamilies("sandbox", { ...DEPLOYMENT, SDP_RELEASE_CHANNEL: "beta" })).toEqual([
      SANDBOX_UNSET_CUSTODY,
    ]);
  });

  it("lists the pool providers keyed for the project's cluster as provided, in failover order, without default or any URL", async () => {
    for (const [envKey, endpointUrl] of Object.entries(RPC_POOL_URLS)) {
      vi.stubEnv(envKey, endpointUrl);
    }

    const sandbox = await readAs(apiKeyHeaders("sandbox"), DEPLOYMENT);
    const production = await readAs(apiKeyHeaders("production"), DEPLOYMENT);

    expect(sandbox.families).toContainEqual({
      family: "rpc",
      integrations: [
        { provider: "triton", state: { status: "provided", modes: [] } },
        { provider: "alchemy", state: { status: "provided", modes: [] } },
      ],
    });
    expect(production.families).toContainEqual({
      family: "rpc",
      integrations: [{ provider: "quicknode", state: { status: "provided", modes: [] } }],
    });
    expect(JSON.stringify([sandbox, production])).not.toMatch(/:\/\/|hoo2662-rpc-token/);
  });

  it("lists entitled ramp and compliance providers as provided in a Sandbox project", async () => {
    await setOrganizationProviderOverrides(getDb(env), ORGANIZATION_ID, {
      compliance: { range: true },
    });

    expect(
      await readFamilies("sandbox", { ...DEPLOYMENT, ...SANDBOX_RAMP_AND_COMPLIANCE_CREDENTIALS })
    ).toEqual([
      SANDBOX_UNSET_CUSTODY,
      {
        family: "ramps",
        integrations: [
          { provider: "moonpay", state: { status: "provided", modes: [] } },
          { provider: "stripe", state: { status: "provided", modes: [] } },
        ],
      },
      {
        family: "compliance",
        integrations: [{ provider: "range", state: { status: "provided", modes: [] } }],
      },
      PRIVATE_CHANNELS_NOT_CONFIGURED,
    ]);
  });

  it("omits ramps from a Production project while the deployment holds only sandbox ramp keys", async () => {
    const families = await readFamilies("production", {
      ...DEPLOYMENT,
      ...SANDBOX_RAMP_AND_COMPLIANCE_CREDENTIALS,
    });

    expect(families.map((family) => family.family)).not.toContain("ramps");
  });
});
