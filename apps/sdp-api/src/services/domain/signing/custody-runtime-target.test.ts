import type { CustodyProvider } from "@sdp/custody";
import type { SigningPort } from "@sdp/custody/signing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { SigningConfigRecord } from "@/services/adapters";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { RuntimeEnvCredentialSecretStore } from "@/services/credential-secret-store";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_runtime_targets";
const PROJECT_ID = "prj_runtime_targets";
const USER_ID = "usr_runtime_targets";
const CONFIG_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const CONNECTION_PUBLIC_KEY = "11111111111111111111111111111111";

describe("CustodyRuntimeTargets", () => {
  const original = {
    byokEnabled: env.PRIVY_BYOK_ENABLED,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PRIVY_API_BASE_URL = "https://privy.runtime-targets.test/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ address: CONNECTION_PUBLIC_KEY }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    await seedScope();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.PRIVY_BYOK_ENABLED = original.byokEnabled;
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.PRIVY_API_BASE_URL = original.apiBaseUrl;
  });

  it("switches effective signing ON -> OFF -> ON without changing retained targets", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, connection.id);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });

    env.PRIVY_BYOK_ENABLED = "false";
    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });

    env.PRIVY_BYOK_ENABLED = "true";
    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });

    expect(read).toHaveBeenCalledOnce();
    expect(getConfigAdapter).toHaveBeenCalledOnce();
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: config.id,
      default_custody_connection_id: connection.id,
    });
  });

  it("rejects an exact Connection wallet while runtime is off before reading its secret", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, null);
    env.PRIVY_BYOK_ENABLED = "false";
    const read = mockStoredCredentialRead();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "wallet",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        walletId: connection.walletId,
      })
    ).resolves.toMatchObject({ kind: "connection", isRuntimeAvailable: false });

    await expect(
      targets.getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId,
        createConfigAdapterFactory()
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the legacy Config for provider resolution while runtime is off", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, connection.id);
    env.PRIVY_BYOK_ENABLED = "false";
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({ kind: "config", config: { id: config.id } });
  });

  it("keeps an effective same-provider Config ahead of an unselected Connection", async () => {
    const config = await seedConfig({ provider: "privy" });
    await seedConnection();
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({ kind: "config", config: { id: config.id } });
  });

  it.each(["success", "retry_unknown"] as const)(
    "keeps an active matching Project Config ahead of an unselected Connection with %s status",
    async (lastCheckStatus) => {
      const effectiveConfig = await seedConfig({ provider: "turnkey" });
      const matchingConfig = await seedConfig({ provider: "privy" });
      await seedConnection({ lastCheckStatus });
      await setProjectDefault(effectiveConfig.id, null);
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.resolve({
          kind: "provider",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
        })
      ).resolves.toMatchObject({ kind: "config", config: { id: matchingConfig.id } });
    }
  );

  it("keeps a selected unusable Connection ahead of an active matching Config", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection({ lastCheckStatus: "retry_unknown" });
    await setProjectDefault(config.id, connection.id);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({
      kind: "connection",
      connectionId: connection.id,
      isRuntimeAvailable: false,
    });
  });

  it("resolves the sole matching Connection when another provider is effective", async () => {
    const config = await seedConfig({ provider: "turnkey" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({
      kind: "connection",
      connectionId: connection.id,
      isRuntimeAvailable: true,
    });
  });

  it("requires selection when provider resolution finds multiple live Connections", async () => {
    const config = await seedConfig({ provider: "turnkey" });
    await seedConnection({ id: "cconn_first", credentialId: "pcred_first" });
    await seedConnection({ id: "cconn_second", credentialId: "pcred_second" });
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("ignores an unusable Connection when provider resolution has one usable target", async () => {
    const config = await seedConfig({ provider: "turnkey" });
    const connection = await seedConnection({
      id: "cconn_usable",
      credentialId: "pcred_usable",
    });
    await seedConnection({
      id: "cconn_unusable",
      credentialId: "pcred_unusable",
      lastCheckStatus: "retry_unknown",
    });
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({ kind: "connection", connectionId: connection.id });
  });

  it("supports exact unselected Connection and Config wallets while runtime is on", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, null);
    mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, config.walletId, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
  });

  it("fails closed when the selected Connection is unusable", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection({ lastCheckStatus: "retry_unknown" });
    await setProjectDefault(config.id, connection.id);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("fails closed when the selected Connection has no Provider Account fingerprint", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, connection.id);
    await getDb(env)
      .prepare("UPDATE custody_connections SET provider_account_fingerprint = NULL WHERE id = ?")
      .bind(connection.id)
      .run();
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("does not fall back when a selected Connection loses its default wallet", async () => {
    const config = await seedConfig({ provider: "privy" });
    const connection = await seedConnection();
    await setProjectDefault(config.id, connection.id);
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'deactivated', deactivated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(connection.id),
      getDb(env)
        .prepare("DELETE FROM custody_wallets WHERE custody_connection_id = ?")
        .bind(connection.id),
    ]);
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("uses the retained Organization Config when runtime is off", async () => {
    const config = await seedConfig({ provider: "privy", projectId: null });
    const connection = await seedConnection();
    await setOrganizationDefault(config.id);
    await setProjectDefault(null, connection.id);
    env.PRIVY_BYOK_ENABLED = "false";
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
    expect(read).not.toHaveBeenCalled();
  });

  it("does not resolve a default Config owned by another scope", async () => {
    const foreignOrganizationId = "org_runtime_targets_foreign";
    const foreignConfigId = "cust_runtime_targets_foreign";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, 'Foreign runtime targets', 'foreign-runtime-targets', 'individual', 'active')`
        )
        .bind(foreignOrganizationId),
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, status
           ) VALUES (?, ?, NULL, 'privy', 'encrypted', 'test', 'active')`
        )
        .bind(foreignConfigId, foreignOrganizationId),
    ]);
    await setProjectDefault(foreignConfigId, null);
    const getConfigAdapter = createConfigAdapterFactory();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("misses the stored adapter cache after Credential version rotation", async () => {
    const connection = await seedConnection();
    await setProjectDefault(null, connection.id);
    const read = mockStoredCredentialRead();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
    const getConfigAdapter = createConfigAdapterFactory();

    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    expect(read).toHaveBeenCalledOnce();

    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET credential_version = credential_version + 1
         WHERE id = ?`
      )
      .bind(connection.credentialId)
      .run();

    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns a redacted unavailable error when the Credential secret cannot be read", async () => {
    const connection = await seedConnection();
    await setProjectDefault(null, connection.id);
    const read = vi.fn().mockRejectedValue(new Error("raw secret backend error"));
    vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "encrypted_db",
      write: vi.fn(),
      read,
      destroyVersion: vi.fn(),
    });
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId,
        createConfigAdapterFactory()
      )
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Custody credential is temporarily unavailable",
    });
  });

  it("reads runtime-env credentials on every signer resolution", async () => {
    env.PRIVY_APP_ID = "runtime-app-id";
    env.PRIVY_APP_SECRET = "runtime-app-secret";
    const connection = await seedConnection({ backend: "runtime_env" });
    await setProjectDefault(null, connection.id);
    const read = vi.spyOn(RuntimeEnvCredentialSecretStore.prototype, "read");
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
    const getConfigAdapter = createConfigAdapterFactory();

    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("is used by the production SigningService transaction-signer path", async () => {
    const connection = await seedConnection();
    await setProjectDefault(null, connection.id);
    mockStoredCredentialRead();

    await expect(
      createSigningService(env).getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
  });

  it("preserves a same-provider Connection on Config selection and clears it for another provider", async () => {
    const privyConfig = await seedConfig({ provider: "privy" });
    const turnkeyConfig = await seedConfig({ provider: "turnkey" });
    const connection = await seedConnection();
    await setProjectDefault(null, connection.id);
    const configStore = new CustodyConfigStore(getDb(env), env);

    await configStore.setDefaultConfig(ORGANIZATION_ID, PROJECT_ID, privyConfig.id);
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: privyConfig.id,
      default_custody_connection_id: connection.id,
    });

    await configStore.setDefaultConfig(ORGANIZATION_ID, PROJECT_ID, turnkeyConfig.id);
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: turnkeyConfig.id,
      default_custody_connection_id: null,
    });
  });
});

async function seedScope(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Runtime targets', 'runtime-targets', 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID),
    getDb(env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'runtime-targets@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (?, ?, 'Runtime targets', 'runtime-targets', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID),
  ]);
}

async function seedConfig(params: {
  provider: CustodyProvider;
  projectId?: string | null;
}): Promise<{ id: string; walletId: string }> {
  const projectId = params.projectId === undefined ? PROJECT_ID : params.projectId;
  const id = `cust_runtime_${params.provider}_${projectId ?? "org"}`;
  const walletId = `wallet_${params.provider}_${projectId ?? "org"}`;
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, default_wallet_id, status
         ) VALUES (?, ?, ?, ?, 'encrypted', 'test', ?, 'active')`
      )
      .bind(id, ORGANIZATION_ID, projectId, params.provider, walletId),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(`cwlt_${id}`, id, walletId, CONFIG_PUBLIC_KEY),
  ]);
  return { id, walletId };
}

async function seedConnection(
  params: {
    id?: string;
    credentialId?: string;
    backend?: "encrypted_db" | "runtime_env";
    lastCheckStatus?: "success" | "retry_unknown";
  } = {}
): Promise<{ id: string; credentialId: string; walletId: string }> {
  const id = params.id ?? "cconn_runtime_targets";
  const credentialId = params.credentialId ?? "pcred_runtime_targets";
  const walletId = `privy_${id}`;
  const backend = params.backend ?? "encrypted_db";
  const source = backend === "runtime_env" ? "runtime" : "stored";
  const encryptedPayload = backend === "encrypted_db" ? "ciphertext" : null;
  const lastCheckStatus = params.lastCheckStatus ?? "success";
  const connectionStatus = lastCheckStatus === "success" ? "active" : "pending";

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, credential_version, created_by
         ) VALUES (?, ?, ?, 'privy', 'Runtime Privy', 'project', ?, ?, ?, 'active', 1, ?)`
      )
      .bind(credentialId, ORGANIZATION_ID, PROJECT_ID, source, backend, encryptedPayload, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(id, ORGANIZATION_ID, PROJECT_ID, credentialId, PROJECT_ID, USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(`cwlt_${id}`, id, walletId, CONNECTION_PUBLIC_KEY),
    getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = ?,
             last_check_status = ?, last_check_at = sdp_iso_now(),
             provider_account_fingerprint = ?,
             activated_at = CASE WHEN ? = 'active' THEN sdp_iso_now() ELSE NULL END
         WHERE id = ?`
      )
      .bind(
        `cwlt_${id}`,
        connectionStatus,
        lastCheckStatus,
        `sha256:${credentialId}`,
        connectionStatus,
        id
      ),
  ]);
  return { id, credentialId, walletId };
}

async function setProjectDefault(
  configId: string | null,
  connectionId: string | null
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_scope_defaults (
         id, organization_id, project_id,
         default_custody_config_id, default_custody_connection_id
       ) VALUES ('csd_runtime_targets', ?, ?, ?, ?)`
    )
    .bind(ORGANIZATION_ID, PROJECT_ID, configId, connectionId)
    .run();
}

async function setOrganizationDefault(configId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_scope_defaults (
         id, organization_id, project_id, default_custody_config_id
       ) VALUES ('csd_runtime_targets_org', ?, NULL, ?)`
    )
    .bind(ORGANIZATION_ID, configId)
    .run();
}

async function getProjectDefault(): Promise<{
  default_custody_config_id: string | null;
  default_custody_connection_id: string | null;
} | null> {
  return getDb(env)
    .prepare(
      `SELECT default_custody_config_id, default_custody_connection_id
       FROM custody_scope_defaults
       WHERE organization_id = ? AND project_id = ?`
    )
    .bind(ORGANIZATION_ID, PROJECT_ID)
    .first();
}

function mockStoredCredentialRead() {
  const read = vi.fn().mockResolvedValue({
    appId: "stored-app-id",
    appSecret: "stored-app-secret",
  });
  vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
    storageBackend: "encrypted_db",
    write: vi.fn(),
    read,
    destroyVersion: vi.fn(),
  });
  return read;
}

function createConfigAdapterFactory() {
  const adapter = {
    providerId: "privy",
    getPublicKey: vi.fn().mockResolvedValue(CONFIG_PUBLIC_KEY),
    sign: vi.fn().mockResolvedValue({ status: "completed", signatures: new Map() }),
    requiresApproval: vi.fn().mockReturnValue(false),
    getTransactionSigner: vi.fn().mockResolvedValue({
      address: CONFIG_PUBLIC_KEY,
      signTransactions: vi.fn(),
    }),
  } as unknown as SigningPort;

  return vi.fn(async (_orgId: string, _config: SigningConfigRecord) => adapter);
}
