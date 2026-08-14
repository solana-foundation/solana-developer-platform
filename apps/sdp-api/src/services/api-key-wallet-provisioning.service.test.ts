import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { loadApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { SigningService } from "@/services/domain/signing.service";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import { provisionApiKeyWallet } from "./api-key-wallet-provisioning.service";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const ORGANIZATION_ID = "org_api_key_provisioning";
const PROJECT_ID = "prj_api_key_provisioning";
const CONNECTION_ID = "cconn_api_key_provisioning";
const FOREIGN_PROJECT_ID = "prj_api_key_provisioning_foreign";
const FOREIGN_CONNECTION_ID = "cconn_api_key_provisioning_foreign";
const CONFIG_ID = "cust_cfg_api_key_provisioning";
const API_KEY = { id: "key_api_key_provisioning", raw: "sk_test_api_key_provisioning" };
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
const createConfigWalletMock = vi.spyOn(SigningService.prototype, "createWallet");
const originalEnv = {
  byok: env.PRIVY_BYOK_ENABLED,
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
};

describe("provisionApiKeyWallet", () => {
  beforeEach(async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "api-key-provisioning-app";
    env.PRIVY_APP_SECRET = "api-key-provisioning-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = originalEnv.byok;
    env.PRIVY_APP_ID = originalEnv.appId;
    env.PRIVY_APP_SECRET = originalEnv.appSecret;
    vi.clearAllMocks();
    await clearKVStores(env);
  });

  it.each([undefined, CONNECTION_ID])(
    "uses the effective or exact Connection without changing defaults (%s)",
    async (connectionId) => {
      if (connectionId) {
        await getDb(env)
          .prepare(
            `UPDATE custody_scope_defaults
             SET default_custody_connection_id = NULL
             WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .run();
      }
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: connectionId ? "exact_api_key_wallet" : "effective_api_key_wallet",
        address: "Vote111111111111111111111111111111111111111",
      });

      const wallet = await provisionApiKeyWallet(getDb(env), env, {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId,
        label: "API key wallet",
        purpose: "transfer",
      });

      expect(wallet.walletId).toBe(
        connectionId ? "privy_exact_api_key_wallet" : "privy_effective_api_key_wallet"
      );
      expect(
        await getDb(env)
          .prepare(
            `SELECT custody_connection_id, custody_config_id FROM custody_wallets WHERE id = ?`
          )
          .bind(wallet.id)
          .first()
      ).toEqual({ custody_connection_id: CONNECTION_ID, custody_config_id: null });
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: "cwlt_api_key_provisioning_default" });
      expect(
        await getDb(env)
          .prepare(
            `SELECT default_custody_config_id, default_custody_connection_id
             FROM custody_scope_defaults WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .first()
      ).toEqual({
        default_custody_config_id: CONFIG_ID,
        default_custody_connection_id: connectionId ? null : CONNECTION_ID,
      });
    }
  );

  it.each(["/v1/api-keys", `/v1/projects/${PROJECT_ID}/api-keys`])(
    "provisions and binds a Connection wallet through %s",
    async (path) => {
      await getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_connection_id = NULL
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .run();
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: "endpoint_api_key_wallet",
        address: "Vote111111111111111111111111111111111111111",
      });

      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Connection key ${path}`,
            walletScope: "selected",
            provisionWallet: { connectionId: CONNECTION_ID },
          }),
        },
        env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { apiKey: { id: string } } };
      const binding = await getDb(env)
        .prepare(
          `SELECT p.wallet_id, w.id AS resolved_custody_wallet_id, w.custody_connection_id
           FROM api_key_wallet_permissions p
           JOIN custody_wallets w ON w.wallet_id = p.wallet_id
           WHERE p.api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first();
      expect(binding).toEqual({
        wallet_id: "privy_endpoint_api_key_wallet",
        resolved_custody_wallet_id: expect.any(String),
        custody_connection_id: CONNECTION_ID,
      });
      await expect(
        loadApiKeyWalletAuthorization(
          getDb(env),
          body.data.apiKey.id,
          ORGANIZATION_ID,
          PROJECT_ID,
          "privy_endpoint_api_key_wallet"
        )
      ).resolves.toMatchObject({
        walletScope: "selected",
        walletBindings: [
          {
            walletId: "privy_endpoint_api_key_wallet",
            custodyWalletId: binding?.resolved_custody_wallet_id,
          },
        ],
      });
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: "cwlt_api_key_provisioning_default" });
      expect(
        await getDb(env)
          .prepare(
            `SELECT default_custody_connection_id
             FROM custody_scope_defaults
             WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .first()
      ).toEqual({ default_custody_connection_id: null });
    }
  );

  it.each(["/v1/api-keys", `/v1/projects/${PROJECT_ID}/api-keys`])(
    "rejects the obsolete top-level Connection selector through %s",
    async (path) => {
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Invalid Connection key ${path}`,
            walletScope: "selected",
            provisionWallet: true,
            connectionId: CONNECTION_ID,
          }),
        },
        env
      );

      expect(response.status).toBe(400);
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(createConfigWalletMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", "/v1/api-keys", "missing_connection", "true", 404],
    ["foreign", `/v1/projects/${PROJECT_ID}/api-keys`, FOREIGN_CONNECTION_ID, "true", 404],
    ["runtime disabled", "/v1/api-keys", CONNECTION_ID, "false", 403],
  ] as const)(
    "rejects %s Connection provisioning before Provider I/O",
    async (_, path, connectionId, flag, status) => {
      env.PRIVY_BYOK_ENABLED = flag;
      const walletCountBefore = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
        .first<{ count: number }>();

      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Rejected Connection key ${connectionId}`,
            walletScope: "selected",
            provisionWallet: { connectionId },
          }),
        },
        env
      );

      expect(response.status).toBe(status);
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(
        await getDb(env)
          .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
          .first<{ count: number }>()
      ).toEqual(walletCountBefore);
    }
  );

  it("rejects an unusable exact Connection before Provider I/O", async () => {
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind("pcred_api_key_provisioning")
      .run();

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Unusable Connection key",
          walletScope: "selected",
          provisionWallet: { connectionId: CONNECTION_ID },
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("binds an existing Connection wallet while runtime is disabled", async () => {
    env.PRIVY_BYOK_ENABLED = "false";

    const response = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Existing Connection wallet key",
          walletScope: "selected",
          signingWalletId: "privy_api_key_default",
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { apiKey: { id: string } } };
    expect(
      await getDb(env)
        .prepare(
          `SELECT wallet_id
           FROM api_key_wallet_permissions
           WHERE api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ wallet_id: "privy_api_key_default" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("preserves Config provisioning when connectionId is omitted", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_api_key_config_provisioned', ?, 'para_api_key_config_provisioned',
                 'Vote111111111111111111111111111111111111111', 'active')`
      )
      .bind(CONFIG_ID)
      .run();
    createConfigWalletMock.mockResolvedValueOnce({
      id: "cwlt_api_key_config_provisioned",
      walletId: "para_api_key_config_provisioned",
    } as never);

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Config compatibility key",
          walletScope: "selected",
          provisionWallet: true,
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(createConfigWalletMock).toHaveBeenCalledWith(ORGANIZATION_ID, PROJECT_ID, {
      label: undefined,
      purpose: undefined,
    });
    const body = (await response.json()) as { data: { apiKey: { id: string } } };
    expect(
      await db
        .prepare(
          `SELECT wallet_id
           FROM api_key_wallet_permissions
           WHERE api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ wallet_id: "para_api_key_config_provisioned" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });
});

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const fingerprint = await getPrivyProviderAccountFingerprint(env.PRIVY_APP_ID as string);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "API key provisioning",
        "api-key-provisioning",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind("usr_api_key_provisioning", "api-key-provisioning@example.com"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'API key provisioning', 'api-key-provisioning', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Foreign API key provisioning', 'api-key-provisioning-foreign',
                 'sandbox', 'active', ?)`
      )
      .bind(FOREIGN_PROJECT_ID, ORGANIZATION_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, 'usr_api_key_provisioning', 'Admin', 'sk_test_api', ?,
                 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY.id, ORGANIZATION_ID, PROJECT_ID, keyHash),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'para', 'test', 'active')`
      )
      .bind(CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, status, created_by)
         VALUES ('pcred_api_key_provisioning', ?, ?, 'privy', 'Privy', 'project', 'runtime',
                 'runtime_env', 'active', ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, status, created_by)
         VALUES ('pcred_api_key_provisioning_foreign', ?, ?, 'privy', 'Privy', 'project',
                 'runtime', 'runtime_env', 'pending', ?)`
      )
      .bind(ORGANIZATION_ID, FOREIGN_PROJECT_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, created_by)
         VALUES (?, ?, ?, 'privy', 'project', 'pcred_api_key_provisioning', ?, 'pending', ?)`
      )
      .bind(CONNECTION_ID, ORGANIZATION_ID, PROJECT_ID, PROJECT_ID, "usr_api_key_provisioning"),
    db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, created_by)
         VALUES (?, ?, ?, 'privy', 'project', 'pcred_api_key_provisioning_foreign', ?,
                 'pending', ?)`
      )
      .bind(
        FOREIGN_CONNECTION_ID,
        ORGANIZATION_ID,
        FOREIGN_PROJECT_ID,
        FOREIGN_PROJECT_ID,
        "usr_api_key_provisioning"
      ),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, status)
         VALUES ('cwlt_api_key_provisioning_default', ?, 'privy_api_key_default',
                 '11111111111111111111111111111111', 'Default', 'active')`
      )
      .bind(CONNECTION_ID),
    db
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), provider_account_fingerprint = ?,
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind("cwlt_api_key_provisioning_default", fingerprint, CONNECTION_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id, default_custody_connection_id)
         VALUES ('csd_api_key_provisioning', ?, ?, ?, ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID),
  ]);
}
