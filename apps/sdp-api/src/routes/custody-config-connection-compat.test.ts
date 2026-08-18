import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_custody_config_connection_compat";
const PROJECT_ID = "prj_custody_config_connection_compat";
const USER_ID = "usr_custody_config_connection_compat";
const CONFIG_ID = "cust_config_connection_compat";
const CONFIG_WALLET_ID = "para_config_connection_wallet";
const CREDENTIAL_ID = "pcred_config_connection_compat";
const CONNECTION_ID = "cconn_config_connection_compat";
const CONNECTION_WALLET_RECORD_ID = "cwlt_config_connection_compat";
const CONNECTION_WALLET_ID = "privy_config_connection_wallet";
const API_KEY = {
  id: "key_custody_config_connection_compat",
  raw: "sk_test_custody_config_connection_compat",
  prefix: "sk_test_ccc",
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

describe("custody Config compatibility with an effective Connection", () => {
  const original = {
    privyByokEnabled: env.PRIVY_BYOK_ENABLED,
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
    paraApiKey: env.PARA_API_KEY,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PARA_API_KEY = "para_config_connection_compat";
  });

  afterEach(async () => {
    env.PRIVY_BYOK_ENABLED = original.privyByokEnabled;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    env.PARA_API_KEY = original.paraApiKey;
    await clearKVStores(env);
  });

  it("projects the effective Connection without changing Config response shapes", async () => {
    const config = await request("/v1/wallets/config");
    expect(config.status).toBe(404);

    const configs = await request("/v1/wallets/configs");
    expect(configs.status).toBe(200);
    expect(await configs.json()).toMatchObject({
      data: {
        configs: [{ id: CONFIG_ID, provider: "para", isDefault: false }],
        defaultConfigId: null,
      },
    });

    const options = await request("/v1/wallets/switch-options");
    expect(options.status).toBe(200);
    expect(await readProviderOption(options, "privy")).toMatchObject({
      provider: "privy",
      hasReusableWallet: true,
      needsWalletLabel: false,
      isActive: true,
      isDefault: true,
    });

    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    const unavailableOptions = await request("/v1/wallets/switch-options");
    expect(await readProviderOption(unavailableOptions, "privy")).toMatchObject({
      provider: "privy",
      hasReusableWallet: true,
      needsWalletLabel: false,
      isActive: false,
      isDefault: true,
    });

    env.PRIVY_BYOK_ENABLED = "false";

    const rolledBackConfig = await request("/v1/wallets/config");
    expect(rolledBackConfig.status).toBe(200);
    expect(await rolledBackConfig.json()).toMatchObject({
      data: { config: { id: CONFIG_ID, provider: "para" } },
    });

    const rolledBackConfigs = await request("/v1/wallets/configs");
    expect(await rolledBackConfigs.json()).toMatchObject({
      data: {
        configs: [{ id: CONFIG_ID, provider: "para", isDefault: true }],
        defaultConfigId: CONFIG_ID,
      },
    });

    const rolledBackOptions = await request("/v1/wallets/switch-options");
    expect(await readProviderOption(rolledBackOptions, "para")).toMatchObject({
      provider: "para",
      hasReusableWallet: true,
      needsWalletLabel: false,
      isActive: true,
      isDefault: true,
    });
  });

  it("keeps implicit public-key resolution aligned with the effective target", async () => {
    const connectionPublicKey = await request("/v1/wallets/public-key");
    expect(connectionPublicKey.status).toBe(200);
    expect(await connectionPublicKey.json()).toMatchObject({
      data: { publicKey: "Vote111111111111111111111111111111111111111" },
    });

    env.PRIVY_BYOK_ENABLED = "false";

    const configPublicKey = await request("/v1/wallets/public-key");
    expect(configPublicKey.status).toBe(200);
    expect(await configPublicKey.json()).toMatchObject({
      data: { publicKey: "11111111111111111111111111111111" },
    });
  });
});

async function request(path: string): Promise<Response> {
  return app.request(
    path,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY.raw}` },
    },
    env
  );
}

async function readProviderOption(response: Response, provider: string) {
  const body = (await response.json()) as {
    data: { providers: Array<Record<string, unknown> & { provider: string }> };
  };
  return body.data.providers.find((option) => option.provider === provider);
}

async function seedScope(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  const db = getDb(env);

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Custody Config Connection Compat",
        "custody-config-connection-compat",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "custody-config-connection-compat@example.com", 1, "active"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Custody Config Connection Compat', 'custody-config-connection-compat',
                 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, ?, 'Custody Config Connection Compat', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        USER_ID,
        API_KEY.prefix,
        keyHash,
        JSON.stringify(["*"])
      ),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, 'para', 'test-config', 'sdp-custody-encryption-v1', ?, 'active')`
      )
      .bind(CONFIG_ID, ORGANIZATION_ID, PROJECT_ID, CONFIG_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES ('cwlt_config_connection_compat_config', ?, ?,
                 '11111111111111111111111111111111', 'Config wallet', 'root', 'active')`
      )
      .bind(CONFIG_ID, CONFIG_WALLET_ID),
    db
      .prepare(
        `INSERT INTO provider_credentials
           (id, organization_id, project_id, provider, label, scope, source,
            storage_backend, encrypted_secret_payload, status, created_by)
         VALUES (?, ?, ?, 'privy', 'Privy Connection', 'project', 'stored',
                 'encrypted_db', 'ciphertext', 'active', ?)`
      )
      .bind(CREDENTIAL_ID, ORGANIZATION_ID, PROJECT_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, created_by)
         VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(CONNECTION_ID, ORGANIZATION_ID, PROJECT_ID, CREDENTIAL_ID, PROJECT_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_connection_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, 'Vote111111111111111111111111111111111111111',
                 'Connection wallet', 'root', 'active')`
      )
      .bind(CONNECTION_WALLET_RECORD_ID, CONNECTION_ID, CONNECTION_WALLET_ID),
    db
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), provider_account_fingerprint = 'sha256:compat',
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(CONNECTION_WALLET_RECORD_ID, CONNECTION_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id,
            default_custody_config_id, default_custody_connection_id)
         VALUES ('csd_config_connection_compat', ?, ?, ?, ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, CONFIG_ID, CONNECTION_ID),
  ]);
}
