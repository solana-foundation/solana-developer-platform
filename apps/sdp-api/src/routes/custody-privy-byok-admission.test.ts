import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const findPrivyWalletByExternalIdMock = vi.spyOn(
  custodyProvisioning,
  "findPrivyWalletByExternalId"
);

const ORGANIZATION_ID = "org_privy_byok_admission";
const PROJECT_ID = "prj_privy_byok_admission";
const USER_ID = "usr_privy_byok_admission";
const API_KEY = {
  id: "key_privy_byok_admission",
  raw: "sk_test_privy_byok_admission",
  prefix: "sk_test_priv",
};
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

async function seedActor(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "Privy BYOK Admission", "privy-byok-admission"),
    getDb(env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind(USER_ID, "privy-byok-admission@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "Privy BYOK Admission", "privy-byok-admission", USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys (
           id, organization_id, project_id, created_by, name, key_prefix,
           key_hash, role, permissions, status
         ) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash),
  ]);
}

async function request(
  path: "initialize" | "switch",
  options: { idempotencyKey?: string; requestDelayMs?: number; walletLabel?: string } = {}
): Promise<Response> {
  return app.request(
    `/v1/wallets/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        provider: "privy",
        requestDelayMs: options.requestDelayMs,
        walletLabel: options.walletLabel,
      }),
    },
    env
  );
}

async function seedLegacyConfig(status: "active" | "inactive"): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_configs (
         id, organization_id, project_id, provider, config_encrypted,
         encryption_version, default_wallet_id, status
       ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', ?, ?)`
    )
    .bind(
      "cust_privy_byok_admission",
      ORGANIZATION_ID,
      PROJECT_ID,
      status === "active" ? "privy_wallet_admission" : null,
      status
    )
    .run();
}

async function seedBlockingConnection(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'Stored Privy', 'project', 'stored',
                   'encrypted_db', 'ciphertext', 'pending', ?)`
      )
      .bind("pcred_privy_byok_admission", ORGANIZATION_ID, PROJECT_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key,
           status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(
        "cconn_privy_byok_admission",
        ORGANIZATION_ID,
        PROJECT_ID,
        "pcred_privy_byok_admission",
        PROJECT_ID,
        USER_ID
      ),
  ]);
}

function enableRuntimeSetup(): void {
  env.SDP_DEPLOYMENT_MODE = "self_hosted";
  env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = "false";
  env.PRIVY_APP_ID = "runtime-app-id";
  env.PRIVY_APP_SECRET = "runtime-app-secret";
  env.CUSTODY_ENCRYPTION_KEY = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [] }))
  );
}

async function getRuntimeRowCounts() {
  const counts = await getDb(env)
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM provider_credentials) AS credentials,
         (SELECT COUNT(*) FROM custody_connections) AS connections,
         (SELECT COUNT(*) FROM custody_wallets) AS wallets`
    )
    .first<{ credentials: number; connections: number; wallets: number }>();
  if (!counts) throw new Error("Runtime row count query returned no row");
  return counts;
}

describe("legacy Privy setup admission", () => {
  const original = {
    flag: env.PRIVY_BYOK_ENABLED,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    deploymentMode: env.SDP_DEPLOYMENT_MODE,
    selfHostedStoredSetup: env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedActor();
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = original.flag;
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.SDP_DEPLOYMENT_MODE = original.deploymentMode;
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = original.selfHostedStoredSetup;
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it.each([
    "initialize",
    "switch",
  ] as const)("routes fresh /%s setup to stored credentials before env availability", async (path) => {
    const response = await request(path);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "New Privy setup must use stored credentials",
      },
    });
    const configs = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM custody_configs")
      .first<{ count: number }>();
    expect(configs?.count).toBe(0);
  });

  it("treats inactive Config reactivation as fresh setup", async () => {
    await seedLegacyConfig("inactive");

    const response = await request("switch");

    expect(response.status).toBe(403);
    const config = await getDb(env)
      .prepare(
        `SELECT status
         FROM custody_configs
         WHERE id = 'cust_privy_byok_admission'`
      )
      .first<{ status: string }>();
    expect(config?.status).toBe("inactive");
  });

  it.each([
    "initialize",
    "switch",
  ] as const)("ignores stored Connection state on /%s after flag rollback", async (path) => {
    env.PRIVY_BYOK_ENABLED = "false";
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    env.CUSTODY_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_rollback",
      address: "LegacyRollbackPublicKey",
    });
    await seedBlockingConnection();

    const response = await request(path);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        walletId: "privy_wallet_rollback",
        publicKey: "LegacyRollbackPublicKey",
      },
    });
    expect(
      await getDb(env)
        .prepare("SELECT status FROM custody_connections WHERE id = ?")
        .bind("cconn_privy_byok_admission")
        .first()
    ).toEqual({ status: "pending" });
  });

  it("preserves the initialize conflict for an active exact-project Config", async () => {
    enableRuntimeSetup();
    await seedLegacyConfig("active");

    const response = await request("initialize", { idempotencyKey: "active-config" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: `Signing already initialized for org ${ORGANIZATION_ID} project ${PROJECT_ID}`,
      },
    });
    const createAudits = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE resource_type = 'custody_config' AND action = 'create'`
      )
      .first<{ count: number }>();
    expect(createAudits?.count).toBe(0);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("does not use runtime setup when self-hosted stored setup is enabled", async () => {
    enableRuntimeSetup();
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = "true";

    const response = await request("initialize", { idempotencyKey: "stored-policy" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "New Privy setup must use stored credentials" },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("keeps active Config selection through switch when stored setup is enabled", async () => {
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    await seedLegacyConfig("active");
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES (?, ?, ?, ?)`
      )
      .bind("csd_privy_byok_admission", ORGANIZATION_ID, PROJECT_ID, "cust_privy_byok_admission")
      .run();
    await seedBlockingConnection();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, label, status
         ) VALUES (?, ?, ?, ?, 'Legacy wallet', 'active')`
      )
      .bind(
        "cwlt_privy_byok_admission",
        "cust_privy_byok_admission",
        "privy_wallet_admission",
        "LegacyPublicKey"
      )
      .run();

    const response = await request("switch");

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        configId: "cust_privy_byok_admission",
        walletId: "privy_wallet_admission",
        publicKey: "LegacyPublicKey",
      },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("keeps fresh legacy initialization when stored setup is disabled", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    env.CUSTODY_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_admission",
      address: "LegacyFreshPublicKey",
    });

    const response = await request("initialize");

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        walletId: "privy_wallet_admission",
        publicKey: "LegacyFreshPublicKey",
      },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
  });

  it("initializes a self-hosted runtime Credential, Connection, and first wallet", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_initialize",
      address: "RuntimeInitializePublicKey",
    });

    const response = await request("initialize", {
      idempotencyKey: "runtime-initialize-1",
      requestDelayMs: 125,
      walletLabel: "Runtime treasury",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: Record<string, string>;
    };
    expect(body.data).toMatchObject({
      walletId: "privy_wallet_runtime_initialize",
      publicKey: "RuntimeInitializePublicKey",
    });
    expect(body.data.connectionId).toMatch(/^cconn_/);
    expect(body.data).not.toHaveProperty("configId");
    expect(body.data).not.toHaveProperty("targetType");

    const credential = await getDb(env)
      .prepare(
        `SELECT source, storage_backend, secret_ref, secret_version_ref,
                encrypted_secret_payload, display_metadata, status
         FROM provider_credentials`
      )
      .first<Record<string, unknown>>();
    expect(credential).toMatchObject({
      source: "runtime",
      storage_backend: "runtime_env",
      secret_ref: null,
      secret_version_ref: null,
      encrypted_secret_payload: null,
      status: "active",
    });
    expect(credential?.display_metadata).toEqual({});

    expect(
      await getDb(env)
        .prepare(
          `SELECT c.status, c.default_custody_wallet_id, c.request_delay_ms, w.label,
                  w.custody_config_id, w.custody_connection_id
           FROM custody_connections c
           JOIN custody_wallets w ON w.id = c.default_custody_wallet_id`
        )
        .first()
    ).toMatchObject({
      status: "active",
      request_delay_ms: 125,
      label: "Runtime treasury",
      custody_config_id: null,
      custody_connection_id: body.data.connectionId,
    });
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: null,
      default_custody_connection_id: body.data.connectionId,
    });
  });

  it("does not replace an explicit different-provider Project target", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_unselected",
      address: "RuntimeUnselectedPublicKey",
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted, status
           ) VALUES ('cust_local_target', ?, ?, 'local', 'legacy', 'active')`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID),
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES ('csd_local_target', ?, ?, 'cust_local_target')`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID),
    ]);

    const response = await request("initialize", { idempotencyKey: "runtime-unselected" });

    expect(response.status).toBe(201);
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: "cust_local_target",
      default_custody_connection_id: null,
    });
  });

  it("selects the Connection beside an inactive same-provider Config target", async () => {
    enableRuntimeSetup();
    await seedLegacyConfig("inactive");
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES ('csd_inactive_privy_target', ?, ?, 'cust_privy_byok_admission')`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID)
      .run();
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_selected",
      address: "RuntimeSelectedPublicKey",
    });

    const response = await request("initialize", { idempotencyKey: "runtime-selected" });
    const body = (await response.json()) as { data: { connectionId: string } };

    expect(response.status).toBe(201);
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: "cust_privy_byok_admission",
      default_custody_connection_id: body.data.connectionId,
    });
  });

  it("does not replace a same-provider Config activated during Provider work", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockImplementationOnce(async () => {
      await seedLegacyConfig("active");
      await getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES ('csd_active_privy_target', ?, ?, 'cust_privy_byok_admission')`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .run();
      return {
        walletId: "wallet_runtime_not_selected",
        address: "RuntimeNotSelectedPublicKey",
      };
    });

    const response = await request("initialize", { idempotencyKey: "runtime-not-selected" });

    expect(response.status).toBe(201);
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: "cust_privy_byok_admission",
      default_custody_connection_id: null,
    });
  });

  it("waits for concurrent Project target selection before activating", async () => {
    enableRuntimeSetup();
    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    provisionPrivyWalletMock.mockImplementationOnce(async () => {
      signalProviderStarted();
      await providerRelease;
      return {
        walletId: "wallet_runtime_serialized",
        address: "RuntimeSerializedPublicKey",
      };
    });

    const initialize = request("initialize", { idempotencyKey: "runtime-serialized" });
    await providerStarted;

    let signalProjectLocked!: () => void;
    const projectLocked = new Promise<void>((resolve) => {
      signalProjectLocked = resolve;
    });
    let releaseProject!: () => void;
    const projectRelease = new Promise<void>((resolve) => {
      releaseProject = resolve;
    });
    const lockTransaction = getDb(env).transaction(async (tx) => {
      expect(await new ProviderCredentialStore(tx).lockProject(ORGANIZATION_ID, PROJECT_ID)).toBe(
        true
      );
      signalProjectLocked();
      await projectRelease;
    });
    await projectLocked;

    const lockProject = vi.spyOn(ProviderCredentialStore.prototype, "lockProject");
    const recordInstallationSuccess = vi.spyOn(
      ProviderCredentialStore.prototype,
      "recordInstallationSuccess"
    );
    let initializeSettled = false;
    void initialize.finally(() => {
      initializeSettled = true;
    });
    try {
      releaseProvider();
      await vi.waitFor(() => expect(lockProject).toHaveBeenCalledOnce());
      expect(recordInstallationSuccess).not.toHaveBeenCalled();
      expect(initializeSettled).toBe(false);
    } finally {
      releaseProject();
      await lockTransaction;
    }
    expect((await initialize).status).toBe(201);
    expect(recordInstallationSuccess).toHaveBeenCalledOnce();
  });

  it("requires Idempotency-Key only before fresh runtime creation", async () => {
    enableRuntimeSetup();

    const response = await request("initialize");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST", message: "Idempotency-Key is required" },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(
      await getDb(env).prepare("SELECT COUNT(*) AS count FROM provider_credentials").first()
    ).toEqual({ count: 0 });
  });

  it("replays the same runtime initialization without repeating Provider work", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValue({
      walletId: "wallet_runtime_replay",
      address: "RuntimeReplayPublicKey",
    });
    const options = { idempotencyKey: "runtime-replay", walletLabel: "Replay wallet" };

    const first = await request("initialize", options);
    const second = await request("initialize", options);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { data: unknown };
    const secondBody = (await second.json()) as { data: unknown };
    expect(secondBody.data).toEqual(firstBody.data);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 1, connections: 1, wallets: 1 });
  });

  it.each([
    ["wallet label", { walletLabel: "First label" }, { walletLabel: "Different label" }],
    ["request delay", { requestDelayMs: 100 }, { requestDelayMs: 200 }],
  ])("rejects an idempotency key reused with another %s", async (_field, first, changed) => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValue({
      walletId: "wallet_runtime_conflict",
      address: "RuntimeConflictPublicKey",
    });
    await request("initialize", {
      idempotencyKey: "runtime-conflict",
      ...first,
    });

    const response = await request("initialize", {
      idempotencyKey: "runtime-conflict",
      ...changed,
    });

    expect(response.status).toBe(409);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
  });

  it("converges concurrent same-key requests on one runtime installation", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValue({
      walletId: "wallet_runtime_concurrent",
      address: "RuntimeConcurrentPublicKey",
    });
    const options = { idempotencyKey: "runtime-concurrent", walletLabel: "Concurrent wallet" };

    const responses = await Promise.all([
      request("initialize", options),
      request("initialize", options),
    ]);

    const statuses = responses.map((response) => response.status);
    expect(statuses).toContain(201);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
  });

  it("reconciles a retry-unknown runtime installation with the same key", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockRejectedValueOnce(new Error("Provider response was lost"));
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_reconciled",
      address: "RuntimeReconciledPublicKey",
    });
    const options = { idempotencyKey: "runtime-reconcile", walletLabel: "Recovered wallet" };

    const first = await request("initialize", options);
    expect(first.status).toBe(503);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    const second = await request("initialize", options);

    expect(provisionPrivyWalletMock).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({
      data: {
        walletId: "privy_wallet_runtime_reconciled",
        publicKey: "RuntimeReconciledPublicKey",
      },
    });
    expect(provisionPrivyWalletMock.mock.calls[1]?.[1]).toEqual(
      provisionPrivyWalletMock.mock.calls[0]?.[1]
    );
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 1, connections: 1, wallets: 1 });
  });

  it("fails a retry closed when the runtime Provider account changes", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockRejectedValueOnce(new Error("Provider response was lost"));
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_account_restored",
      address: "RuntimeAccountRestoredPublicKey",
    });
    const options = { idempotencyKey: "runtime-account-changed" };

    expect((await request("initialize", options)).status).toBe(503);
    env.PRIVY_APP_ID = "another-runtime-app-id";
    expect((await request("initialize", options)).status).toBe(409);
    env.PRIVY_APP_ID = "runtime-app-id";
    const recovered = await request("initialize", options);

    expect(recovered.status).toBe(201);
    expect(provisionPrivyWalletMock).toHaveBeenCalledTimes(2);
    expect(
      await getDb(env)
        .prepare(
          `SELECT c.status AS connection_status, pc.status AS credential_status
           FROM custody_connections c
           JOIN provider_credentials pc ON pc.id = c.provider_credential_id`
        )
        .first()
    ).toEqual({ connection_status: "active", credential_status: "active" });
  });

  it("reconciles a pinned same-key attempt after the runtime flag is disabled", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockRejectedValueOnce(new Error("Provider response was lost"));
    findPrivyWalletByExternalIdMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_flag_off_reconciled",
      address: "RuntimeFlagOffReconciledPublicKey",
    });
    const options = { idempotencyKey: "runtime-flag-off-reconcile" };

    expect((await request("initialize", options)).status).toBe(503);
    env.PRIVY_BYOK_ENABLED = "false";
    const recovered = await request("initialize", options);

    expect(recovered.status).toBe(201);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(findPrivyWalletByExternalIdMock).toHaveBeenCalledOnce();
    expect(
      await getDb(env)
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM custody_configs) AS configs,
             (SELECT COUNT(*) FROM custody_scope_defaults) AS project_targets`
        )
        .first()
    ).toEqual({ configs: 0, project_targets: 0 });
  });

  it("allows only one concurrent runtime installation across different keys", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValue({
      walletId: "wallet_runtime_single_winner",
      address: "RuntimeSingleWinnerPublicKey",
    });

    const responses = await Promise.all([
      request("initialize", { idempotencyKey: "runtime-winner-left" }),
      request("initialize", { idempotencyKey: "runtime-winner-right" }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 1, connections: 1, wallets: 1 });
  });

  it("rejects a new key after runtime setup is active", async () => {
    enableRuntimeSetup();
    provisionPrivyWalletMock.mockResolvedValue({
      walletId: "wallet_runtime_active",
      address: "RuntimeActivePublicKey",
    });

    expect((await request("initialize", { idempotencyKey: "runtime-active-first" })).status).toBe(
      201
    );
    const response = await request("initialize", { idempotencyKey: "runtime-active-second" });

    expect(response.status).toBe(409);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 1, connections: 1, wallets: 1 });
  });

  it("allows a fresh key after a conclusive failed attempt", async () => {
    enableRuntimeSetup();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      Response.json({ error: "invalid credentials" }, { status: 401 })
    );
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_runtime_after_failure",
      address: "RuntimeAfterFailurePublicKey",
    });

    const failed = await request("initialize", { idempotencyKey: "runtime-failed" });
    const retried = await request("initialize", { idempotencyKey: "runtime-after-failure" });

    expect(failed.status).toBe(400);
    expect(retried.status).toBe(201);
    expect(await getRuntimeRowCounts()).toEqual({ credentials: 2, connections: 2, wallets: 1 });
  });
});
