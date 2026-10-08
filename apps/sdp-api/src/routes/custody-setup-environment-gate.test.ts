import {
  type CachedApiKey,
  CUSTODY_PROVIDERS,
  type CustodyProvider,
  type SdpEnvironment,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { getLogger } from "@/runtime/logger";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { seedProjectApiKey, type TestApiKeyMaterial } from "@/test/helpers/api-keys";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_custody_setup_gate";
const USER_ID = "usr_custody_setup_gate";
const PROJECT_IDS = {
  sandbox: "prj_custody_setup_gate_sandbox",
  production: "prj_custody_setup_gate_production",
} as const satisfies Record<SdpEnvironment, string>;
const API_KEYS = {
  sandbox: {
    id: "key_custody_setup_gate_sandbox",
    raw: "sk_test_custody_setup_gate",
    prefix: "sk_test_csg",
  },
  production: {
    id: "key_custody_setup_gate_production",
    raw: "sk_live_custody_setup_gate",
    prefix: "sk_live_csg",
  },
} as const satisfies Record<SdpEnvironment, TestApiKeyMaterial>;
const APP_ID = "privy-app-setup-gate";
const PRIVY_API_BASE_URL = "https://privy.custody-setup-gate.test/v1";
const PRIVY_WALLET_ID = "wallet-custody-setup-gate";
const PRIVY_WALLET_ADDRESS = "wallet-address-custody-setup-gate";
const SUBMISSION_BODY = {
  provider: "privy",
  fields: {
    credentialLabel: "Treasury Privy",
    scope: "project",
    appId: APP_ID,
    appSecret: "setup gate secret",
  },
} as const;
const MANAGED_LABELS = {
  local: "Local",
  fireblocks: "Fireblocks",
  privy: "Privy",
  coinbase_cdp: "Coinbase CDP",
  para: "Para",
  turnkey: "Turnkey",
  dfns: "DFNS",
  ibm_haven: "IBM Digital Asset Haven",
  anchorage: "Anchorage",
  utila: "Utila",
} as const satisfies Record<CustodyProvider, string>;
const NOT_STABLE_REFUSAL = {
  error: {
    code: "FORBIDDEN",
    message: "Privy BYOK custody is not stable yet, so a production project cannot use it.",
    details: { reason: "custody_mode_not_allowed" },
  },
  meta: { requestId: expect.any(String) },
};

let clerkToken: string;

function cachedApiKey(environment: SdpEnvironment): CachedApiKey {
  return {
    id: API_KEYS[environment].id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    role: "api_admin",
    permissions: ["*"],
    environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'Custody Setup Gate', 'custody-setup-gate', 'individual', 'active')`,
    [ORGANIZATION_ID]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'custody-setup-gate@example.com', 1, 'active')`,
    [USER_ID]
  );
  await db.execute(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES ('mem_custody_setup_gate', ?, ?, 'admin', 'active')`,
    [ORGANIZATION_ID, USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: PROJECT_IDS,
  });
  await seedEnvironmentApiKey("sandbox");
  await seedEnvironmentApiKey("production");
}

async function seedEnvironmentApiKey(environment: SdpEnvironment): Promise<void> {
  const keyHash = await seedProjectApiKey(getDb(env), env, {
    key: API_KEYS[environment],
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    createdBy: USER_ID,
    role: "api_admin",
    permissions: ["*"],
  });
  await seedCachedApiKey(env, keyHash, cachedApiKey(environment));
}

function initialize(environment: SdpEnvironment, provider: CustodyProvider): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/v1/wallets/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEYS[environment].raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider }),
      },
      env
    )
  );
}

function submit(environment: SdpEnvironment, idempotencyKey: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/internal/dashboard/custody/provider-credentials",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clerkToken}`,
          "Content-Type": "application/json",
          "X-Project-ID": PROJECT_IDS[environment],
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(SUBMISSION_BODY),
      },
      env
    )
  );
}

function getConnection(environment: SdpEnvironment, connectionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/internal/dashboard/custody/connections/${connectionId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clerkToken}`,
          "X-Project-ID": PROJECT_IDS[environment],
        },
      },
      env
    )
  );
}

function complete(environment: SdpEnvironment, connectionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/internal/dashboard/custody/connections/${connectionId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clerkToken}`,
          "X-Project-ID": PROJECT_IDS[environment],
        },
      },
      env
    )
  );
}

async function submittedConnectionId(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { connectionId: string } };
  return body.data.connectionId;
}

function stubSuccessfulPrivyInstallation(connectionId: string): void {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json({ data: [], next_cursor: null }))
    .mockResolvedValueOnce(Response.json({ error: "wallet not found" }, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        id: PRIVY_WALLET_ID,
        address: PRIVY_WALLET_ADDRESS,
        chain_type: "solana",
        external_id: `sdp_${connectionId}`,
      })
    );
}

function completionBody(environment: SdpEnvironment, connectionId: string) {
  return {
    data: {
      providerCredential: {
        id: expect.stringMatching(/^pcred_/),
        provider: "privy",
        label: "Treasury Privy",
        scope: "project",
        projectId: PROJECT_IDS[environment],
        status: "active",
        createdAt: expect.any(String),
        displayMetadata: { appIdSuffix: "gate" },
      },
      connectionId,
      completion: { status: "success", attemptedAt: expect.any(String) },
    },
    meta: { requestId: expect.any(String), timestamp: expect.any(String) },
  };
}

async function custodyRows() {
  const db = getDb(env);
  return {
    configs: await db.queryMany("SELECT * FROM custody_configs ORDER BY id"),
    wallets: await db.queryMany("SELECT * FROM custody_wallets ORDER BY id"),
    credentials: await db.queryMany("SELECT * FROM provider_credentials ORDER BY id"),
    connections: await db.queryMany("SELECT * FROM custody_connections ORDER BY id"),
  };
}

async function auditRows() {
  return getDb(env).queryMany("SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY id", [
    ORGANIZATION_ID,
  ]);
}

const NO_CUSTODY_ROWS = { configs: [], wallets: [], credentials: [], connections: [] };
const REFUSAL_EVENT = "sdp_api_custody_setup_refused";

function spyOnWarn() {
  const logger = getLogger();
  return vi.spyOn(logger, "warn").mockImplementation(() => logger);
}

function refusalLogs(warn: ReturnType<typeof spyOnWarn>) {
  return warn.mock.calls.filter((call) => call[1] === REFUSAL_EVENT);
}

function refusalLog(environment: SdpEnvironment, mode: "managed" | "byok") {
  return [
    {
      event: REFUSAL_EVENT,
      organization_id: ORGANIZATION_ID,
      project_id: PROJECT_IDS[environment],
      environment,
      provider: "privy",
      mode,
      reason: "custody_mode_not_allowed",
    },
    REFUSAL_EVENT,
  ];
}

describe("Custody setup by project environment", () => {
  const original = {
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
    privyApiBaseUrl: env.PRIVY_API_BASE_URL,
    backend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    fingerprintPepper: env.CREDENTIAL_FINGERPRINT_PEPPER,
  };

  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    custodyReleaseChannel.stageOverride = null;
    vi.clearAllMocks();
    env.PRIVY_APP_ID = "managed-privy-app-id";
    env.PRIVY_APP_SECRET = "managed-privy-app-secret";
    env.PRIVY_API_BASE_URL = PRIVY_API_BASE_URL;
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    env.CREDENTIAL_FINGERPRINT_PEPPER = "custody-setup-gate-fingerprint-pepper";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
    clerkToken = await signSeededClerkMember(env, getDb(env), USER_ID, ORGANIZATION_ID);
    await verifyClerkJwt(clerkToken, env);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    env.PRIVY_API_BASE_URL = original.privyApiBaseUrl;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.CREDENTIAL_FINGERPRINT_PEPPER = original.fingerprintPepper;
    await clearKVStores(env);
  });

  it.each(CUSTODY_PROVIDERS.map((provider) => ({ provider, label: MANAGED_LABELS[provider] })))(
    "refuses Managed $provider initialization in a Production project before any Provider call, row or audit",
    async ({ provider, label }) => {
      const response = await initialize("production", provider);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: `${label} Managed custody is not allowed in a production project.`,
          details: { reason: "custody_mode_not_allowed" },
        },
        meta: { requestId: expect.any(String) },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(await custodyRows()).toEqual(NO_CUSTODY_ROWS);
      expect(await auditRows()).toEqual([]);
    }
  );

  it("refuses Managed Privy initialization in a Sandbox project when the deployment lacks Privy credentials", async () => {
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;

    const response = await initialize("sandbox", "privy");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Privy is not configured in this environment.",
        details: { reason: "provider_not_configured" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(await custodyRows()).toEqual(NO_CUSTODY_ROWS);
    expect(await auditRows()).toEqual([]);
  });

  it("submits and completes BYOK Privy in a Production project", async () => {
    const connectionId = await submittedConnectionId(await submit("production", "gate-prod-byok"));
    stubSuccessfulPrivyInstallation(connectionId);

    const response = await complete("production", connectionId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(completionBody("production", connectionId));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      await getDb(env).queryOne(
        "SELECT project_id, provider, status, provider_account_fingerprint FROM custody_connections WHERE id = ?",
        [connectionId]
      )
    ).toEqual({
      project_id: PROJECT_IDS.production,
      provider: "privy",
      status: "active",
      provider_account_fingerprint: await getPrivyProviderAccountFingerprint(APP_ID),
    });
  });

  it("sets up Managed Privy and then BYOK Privy side by side in a Sandbox project", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_setup_gate_managed",
      address: "ManagedSetupGatePublicKey",
    });

    const initialized = await initialize("sandbox", "privy");
    expect(initialized.status).toBe(201);
    const { data: managed } = (await initialized.json()) as { data: { configId: string } };
    const connectionId = await submittedConnectionId(await submit("sandbox", "gate-sandbox-byok"));
    stubSuccessfulPrivyInstallation(connectionId);
    const completed = await complete("sandbox", connectionId);

    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual(completionBody("sandbox", connectionId));
    expect(
      await getDb(env).queryMany(
        "SELECT id, project_id, provider, status FROM custody_configs ORDER BY id"
      )
    ).toEqual([
      {
        id: managed.configId,
        project_id: PROJECT_IDS.sandbox,
        provider: "privy",
        status: "active",
      },
    ]);
    expect(
      await getDb(env).queryMany(
        "SELECT id, project_id, provider, status FROM custody_connections ORDER BY id"
      )
    ).toEqual([
      { id: connectionId, project_id: PROJECT_IDS.sandbox, provider: "privy", status: "active" },
    ]);
    expect(
      await getDb(env).queryMany(
        `SELECT wallet_id, public_key, custody_config_id, custody_connection_id, status
         FROM custody_wallets ORDER BY custody_connection_id NULLS FIRST`
      )
    ).toEqual([
      {
        wallet_id: "privy_wallet_setup_gate_managed",
        public_key: "ManagedSetupGatePublicKey",
        custody_config_id: managed.configId,
        custody_connection_id: null,
        status: "active",
      },
      {
        wallet_id: `privy_${PRIVY_WALLET_ID}`,
        public_key: PRIVY_WALLET_ADDRESS,
        custody_config_id: null,
        custody_connection_id: connectionId,
        status: "active",
      },
    ]);
  });

  it("refuses a BYOK submission in a Production project when the pair is not stable, though the release channel offers it", async () => {
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };

    const response = await submit("production", "gate-prod-beta");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(NOT_STABLE_REFUSAL);
    expect(fetch).not.toHaveBeenCalled();
    expect(await custodyRows()).toEqual(NO_CUSTODY_ROWS);
    expect(await auditRows()).toEqual([]);
  });

  it("refuses completing a Production installation once its pair is not stable, leaving every row unchanged", async () => {
    const connectionId = await submittedConnectionId(
      await submit("production", "gate-prod-then-beta")
    );
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };
    const before = { rows: await custodyRows(), audits: await auditRows() };

    const response = await complete("production", connectionId);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(NOT_STABLE_REFUSAL);
    expect(fetch).not.toHaveBeenCalled();
    expect({ rows: await custodyRows(), audits: await auditRows() }).toEqual(before);
  });

  it("admits the same non-stable pair through submission and completion in a Sandbox project", async () => {
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };

    const connectionId = await submittedConnectionId(await submit("sandbox", "gate-sandbox-beta"));
    stubSuccessfulPrivyInstallation(connectionId);
    const response = await complete("sandbox", connectionId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(completionBody("sandbox", connectionId));
  });

  it("replays a Production submission whose retry the stage gate would refuse, and refuses a new key", async () => {
    const first = await submit("production", "gate-prod-replay");
    expect(first.status).toBe(201);
    const { data: firstData } = (await first.json()) as { data: Record<string, unknown> };
    custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };
    const afterFirst = await custodyRows();

    const replay = await submit("production", "gate-prod-replay");
    const fresh = await submit("production", "gate-prod-fresh");

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      data: firstData,
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(fresh.status).toBe(403);
    expect(await fresh.json()).toEqual(NOT_STABLE_REFUSAL);
    expect(fetch).not.toHaveBeenCalled();
    expect(await custodyRows()).toEqual(afterFirst);
  });

  describe("refusal logging and archived projects", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(() => {
      warn = spyOnWarn();
      return () => {
        warn.mockRestore();
      };
    });

    it("logs a refused Managed initialization in a Production project exactly once", async () => {
      const response = await initialize("production", "privy");

      expect(response.status).toBe(403);
      expect(refusalLogs(warn)).toEqual([refusalLog("production", "managed")]);
    });

    it("reads a Production installation the gate refuses without logging, and logs its refused completion exactly once", async () => {
      const connectionId = await submittedConnectionId(
        await submit("production", "gate-prod-read-then-complete")
      );
      custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };

      const read = await getConnection("production", connectionId);

      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({
        data: {
          connection: {
            id: connectionId,
            provider: "privy",
            label: "Treasury Privy",
            status: "pending",
            completion: null,
            canComplete: false,
            canReplaceCredentials: false,
            canCancel: true,
          },
        },
        meta: { requestId: expect.any(String), timestamp: expect.any(String) },
      });
      expect(refusalLogs(warn)).toEqual([]);

      const completed = await complete("production", connectionId);

      expect(completed.status).toBe(403);
      expect(await completed.json()).toEqual(NOT_STABLE_REFUSAL);
      expect(refusalLogs(warn)).toEqual([refusalLog("production", "byok")]);
    });

    it("replays a Production submission the gate refuses without logging, and logs a refused new submission exactly once", async () => {
      await submittedConnectionId(await submit("production", "gate-prod-log-replay"));
      custodyReleaseChannel.stageOverride = { provider: "privy", mode: "byok", stage: "beta" };

      const replay = await submit("production", "gate-prod-log-replay");

      expect(replay.status).toBe(201);
      expect(refusalLogs(warn)).toEqual([]);

      const fresh = await submit("production", "gate-prod-log-fresh");

      expect(fresh.status).toBe(403);
      expect(refusalLogs(warn)).toEqual([refusalLog("production", "byok")]);
    });

    it.each(["sandbox", "production"] as const)(
      "answers not found for Managed initialization in an archived %s project, writing nothing and logging no refusal",
      async (environment) => {
        await getDb(env)
          .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
          .bind(PROJECT_IDS[environment])
          .run();

        const response = await initialize(environment, "privy");

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: "NOT_FOUND", message: "Project not found" },
          meta: { requestId: expect.any(String) },
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
        expect(await custodyRows()).toEqual(NO_CUSTODY_ROWS);
        expect(await auditRows()).toEqual([]);
        expect(refusalLogs(warn)).toEqual([]);
      }
    );
  });
});
