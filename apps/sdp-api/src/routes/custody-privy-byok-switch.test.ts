import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { SigningService } from "@/services/domain/signing.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORG_ID = "org_privy_byok_switch";
const PROJECT_ID = "prj_privy_byok_switch";
const USER_ID = "usr_privy_byok_switch";
const CONFIG_ID = "cust_privy_byok_switch";
const ORGANIZATION_CONFIG_ID = "cust_privy_byok_switch_org";
const CONNECTION_ID = "cconn_privy_byok_switch";
const CREDENTIAL_ID = "pcred_privy_byok_switch";
const CONFIG_WALLET_ID = "privy_legacy_wallet";
const CONNECTION_WALLET_ID = "privy_connection_wallet";
const CREATED_CONNECTION_WALLET_ID = "created_connection_wallet";
const API_KEY = {
  id: "key_privy_byok_switch",
  raw: "sk_test_privy_byok_switch",
  prefix: "sk_test_priv",
};
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORG_ID,
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

async function seedActiveConfigAndConnection(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Privy BYOK Switch', 'privy-byok-switch', 'individual', 'active')`
      )
      .bind(ORG_ID),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'privy-byok-switch@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (?, ?, 'Privy BYOK Switch', 'privy-byok-switch', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORG_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO api_keys (
           id, organization_id, project_id, created_by, name, key_prefix,
           key_hash, role, permissions, status
         ) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY.id, ORG_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash),
    db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, default_wallet_id, status
         ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', ?, 'active')`
      )
      .bind(CONFIG_ID, ORG_ID, PROJECT_ID, CONFIG_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, label, status
         ) VALUES ('cwlt_privy_byok_switch_legacy', ?, ?, 'LegacyPublicKey', 'Legacy', 'active')`
      )
      .bind(CONFIG_ID, CONFIG_WALLET_ID),
    db
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'Stored Privy', 'project', 'stored',
                   'encrypted_db', 'ciphertext', 'active', ?)`
      )
      .bind(CREDENTIAL_ID, ORG_ID, PROJECT_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status,
           setup_metadata, last_check_status, last_check_at, activated_at, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'active',
                   '{"providerAccountFingerprint":"sha256:test"}'::jsonb,
                   'success', sdp_iso_now(), sdp_iso_now(), ?)`
      )
      .bind(CONNECTION_ID, ORG_ID, PROJECT_ID, CREDENTIAL_ID, PROJECT_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, label, status
         ) VALUES ('cwlt_privy_byok_switch_connection', ?, ?,
                   'ConnectionPublicKey', 'Connection', 'active')`
      )
      .bind(CONNECTION_ID, CONNECTION_WALLET_ID),
    db
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = 'cwlt_privy_byok_switch_connection'
         WHERE id = ?`
      )
      .bind(CONNECTION_ID),
  ]);
}

async function prepareCheckedPendingConnection(): Promise<void> {
  const stored = await createCredentialSecretStore(env).write({
    orgId: ORG_ID,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    payload: {
      appId: "stored-app-id",
      appSecret: "stored-app-secret",
    },
  });
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = NULL,
             status = 'pending',
             activated_at = NULL
         WHERE id = ?`
      )
      .bind(CONNECTION_ID),
    db.prepare("DELETE FROM custody_wallets WHERE custody_connection_id = ?").bind(CONNECTION_ID),
    db
      .prepare(
        `UPDATE provider_credentials
         SET storage_backend = ?,
             secret_ref = ?,
             secret_version_ref = ?,
             encrypted_secret_payload = ?,
             status = 'active'
         WHERE id = ?`
      )
      .bind(
        stored.storageBackend,
        stored.secretRef ?? null,
        stored.secretVersionRef ?? null,
        stored.encryptedSecretPayload ?? null,
        CREDENTIAL_ID
      ),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES ('csd_privy_byok_switch', ?, ?, ?)`
      )
      .bind(ORG_ID, PROJECT_ID, CONFIG_ID),
  ]);
}

function stubPrivyWalletCreation() {
  const providerFetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: CREATED_CONNECTION_WALLET_ID,
        address: "CreatedConnectionPublicKey",
        chain_type: "solana",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )
  );
  vi.stubGlobal("fetch", providerFetch);
  return providerFetch;
}

async function switchToPrivy(): Promise<Response> {
  return app.request(
    "/v1/wallets/switch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY.raw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "privy" }),
    },
    env
  );
}

async function getWalletRoute(path: "config" | "configs" | "switch-options"): Promise<Response> {
  return app.request(
    `/v1/wallets/${path}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY.raw}` },
    },
    env
  );
}

describe("Privy BYOK custody target switch", () => {
  const original = {
    byok: env.PRIVY_BYOK_ENABLED,
    deploymentMode: env.SDP_DEPLOYMENT_MODE,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
    custodyPrivateKey: env.CUSTODY_PRIVATE_KEY,
    secretBackend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PRIVY_API_BASE_URL = "https://privy.example.test/v1";
    env.CUSTODY_PRIVATE_KEY = "local-custody-test-private-key";
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
    await seedActiveConfigAndConnection();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.PRIVY_BYOK_ENABLED = original.byok;
    env.SDP_DEPLOYMENT_MODE = original.deploymentMode;
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.PRIVY_API_BASE_URL = original.apiBaseUrl;
    env.CUSTODY_PRIVATE_KEY = original.custodyPrivateKey;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.secretBackend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("selects the active Connection without legacy env credentials and retains Config rollback", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES ('csd_privy_byok_switch', ?, ?, ?)`
      )
      .bind(ORG_ID, PROJECT_ID, CONFIG_ID)
      .run();

    const response = await switchToPrivy();

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body).toMatchObject({
      data: {
        walletId: CONNECTION_WALLET_ID,
        publicKey: "ConnectionPublicKey",
      },
    });
    const target = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id, default_custody_connection_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(ORG_ID, PROJECT_ID)
      .first<{
        default_custody_config_id: string | null;
        default_custody_connection_id: string | null;
      }>();
    expect(target).toEqual({
      default_custody_config_id: CONFIG_ID,
      default_custody_connection_id: CONNECTION_ID,
    });
    expect(body.data).not.toHaveProperty("configId");
  });

  it("uses the legacy Config when disabled and preserves the Connection pointer", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id,
           default_custody_config_id, default_custody_connection_id
         ) VALUES ('csd_privy_byok_switch', ?, ?, ?, ?)`
      )
      .bind(ORG_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID)
      .run();

    const response = await switchToPrivy();

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        configId: CONFIG_ID,
        walletId: CONFIG_WALLET_ID,
        publicKey: "LegacyPublicKey",
      },
    });
    const target = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id, default_custody_connection_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(ORG_ID, PROJECT_ID)
      .first<{
        default_custody_config_id: string | null;
        default_custody_connection_id: string | null;
      }>();
    expect(target).toEqual({
      default_custody_config_id: CONFIG_ID,
      default_custody_connection_id: CONNECTION_ID,
    });
  });

  it("returns the Config wallet selected by the atomic switch commit", async () => {
    vi.spyOn(SigningService.prototype, "setDefaultConfiguration").mockResolvedValue({
      walletId: "wallet_selected_during_commit",
      publicKey: "11111111111111111111111111111111",
    });

    const response = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "local" }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        walletId: "wallet_selected_during_commit",
        publicKey: "11111111111111111111111111111111",
      },
    });
  });

  it("projects the selected Connection without presenting the retained Config as default", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id,
           default_custody_config_id, default_custody_connection_id
         ) VALUES ('csd_privy_byok_switch', ?, ?, ?, ?)`
      )
      .bind(ORG_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID)
      .run();

    const [configResponse, configsResponse, optionsResponse] = await Promise.all([
      getWalletRoute("config"),
      getWalletRoute("configs"),
      getWalletRoute("switch-options"),
    ]);

    expect(configResponse.status).toBe(404);
    expect(configsResponse.status).toBe(200);
    expect(await configsResponse.json()).toMatchObject({
      data: {
        defaultConfigId: null,
        configs: [{ id: CONFIG_ID, isDefault: false }],
      },
    });
    expect(optionsResponse.status).toBe(200);
    expect(await optionsResponse.json()).toMatchObject({
      data: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "privy",
            isActive: true,
            isDefault: true,
          }),
        ]),
      },
    });
  });

  it("does not create the first Connection wallet through switch", async () => {
    await prepareCheckedPendingConnection();
    const providerFetch = stubPrivyWalletCreation();

    const response = await switchToPrivy();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();

    expect(
      await getDb(env)
        .prepare(
          `SELECT c.status, c.default_custody_wallet_id,
                  d.default_custody_config_id, d.default_custody_connection_id,
                  (
                    SELECT COUNT(*)
                    FROM custody_wallets w
                    WHERE w.custody_connection_id = c.id
                  ) AS connection_wallet_count
           FROM custody_connections c
           LEFT JOIN custody_scope_defaults d
             ON d.organization_id = c.organization_id
            AND d.project_id = c.project_id
           WHERE c.id = ?`
        )
        .bind(CONNECTION_ID)
        .first()
    ).toEqual({
      status: "pending",
      default_custody_wallet_id: null,
      default_custody_config_id: CONFIG_ID,
      default_custody_connection_id: null,
      connection_wallet_count: 0,
    });
  });

  it.each([
    ["current-project API", "/v1/api-keys"],
    ["project-resource API", `/v1/projects/${PROJECT_ID}/api-keys`],
  ])("does not bootstrap a pending Connection through the %s", async (_name, path) => {
    await prepareCheckedPendingConnection();
    const providerFetch = stubPrivyWalletCreation();
    const keyName = `Connection key ${path}`;

    const response = await app.request(
      path,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: keyName,
          walletScope: "selected",
          provisionWallet: true,
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await getDb(env)
        .prepare(
          `SELECT COUNT(*) AS count
           FROM api_keys
           WHERE organization_id = ? AND name = ?`
        )
        .bind(ORG_ID, keyName)
        .first()
    ).toEqual({ count: 0 });
  });

  it("keeps current-project API-key provisioning on the Organization Config when disabled", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    stubPrivyWalletCreation();

    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, provider, config_encrypted,
             encryption_version, default_wallet_id, status
           ) VALUES (?, ?, 'privy', ?, 'test', 'privy_org_wallet', 'active')`
        )
        .bind(
          ORGANIZATION_CONFIG_ID,
          ORG_ID,
          JSON.stringify({ provider: "privy", privyAppId: "legacy-app-id" })
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (
             id, custody_config_id, wallet_id, public_key, label, status
           ) VALUES (
             'cwlt_privy_byok_switch_org', ?, 'privy_org_wallet',
             'OrganizationPublicKey', 'Organization', 'active'
           )`
        )
        .bind(ORGANIZATION_CONFIG_ID),
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, default_custody_config_id
           ) VALUES ('csd_privy_byok_switch_org', ?, ?)`
        )
        .bind(ORG_ID, ORGANIZATION_CONFIG_ID),
      getDb(env)
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES ('csd_privy_byok_switch_project', ?, ?, ?)`
        )
        .bind(ORG_ID, PROJECT_ID, CONFIG_ID),
    ]);

    const response = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Legacy organization key",
          walletScope: "selected",
          provisionWallet: true,
        }),
      },
      env
    );

    const responseText = await response.text();
    expect(response.status, responseText).toBe(201);
    const body = JSON.parse(responseText) as { data: { apiKey: { id: string } } };
    expect(
      await getDb(env)
        .prepare(
          `SELECT w.custody_config_id
           FROM api_key_wallet_permissions p
           JOIN custody_wallets w ON w.wallet_id = p.wallet_id
           WHERE p.api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ custody_config_id: ORGANIZATION_CONFIG_ID });
  });

  it("keeps an unusable selected Connection selected and blocks same-provider fallback", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id,
           default_custody_config_id, default_custody_connection_id
         ) VALUES ('csd_privy_byok_switch', ?, ?, ?, ?)`
      )
      .bind(ORG_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID)
      .run();
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'failed', activated_at = NULL
         WHERE id = ?`
      )
      .bind(CONNECTION_ID)
      .run();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const [switchResponse, optionsResponse] = await Promise.all([
      switchToPrivy(),
      getWalletRoute("switch-options"),
    ]);

    expect(switchResponse.status).toBe(409);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await optionsResponse.json()).toMatchObject({
      data: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "privy",
            isActive: false,
            isDefault: true,
          }),
        ]),
      },
    });
  });
});
