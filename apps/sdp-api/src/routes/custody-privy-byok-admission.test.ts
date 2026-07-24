import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

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

async function request(path: "initialize" | "switch"): Promise<Response> {
  return app.request(
    `/v1/wallets/${path}`,
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

describe("legacy Privy setup admission", () => {
  const original = {
    flag: env.PRIVY_BYOK_PROVISIONING_ENABLED,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedActor();
    env.PRIVY_BYOK_PROVISIONING_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
  });

  afterEach(async () => {
    env.PRIVY_BYOK_PROVISIONING_ENABLED = original.flag;
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    await clearTestDatabase(env);
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
  ] as const)("returns the stored-connection conflict from /%s even after flag rollback", async (path) => {
    env.PRIVY_BYOK_PROVISIONING_ENABLED = "false";
    await seedBlockingConnection();

    const response = await request(path);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Privy custody setup already exists for this project",
      },
    });
  });

  it("reuses an active exact-project Config through initialize", async () => {
    env.PRIVY_APP_ID = "legacy-app-id";
    env.PRIVY_APP_SECRET = "legacy-app-secret";
    await seedLegacyConfig("active");
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

    const response = await request("initialize");

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: {
        configId: "cust_privy_byok_admission",
        walletId: "privy_wallet_admission",
        publicKey: "LegacyPublicKey",
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
  });
});
