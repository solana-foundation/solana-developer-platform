import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { seedTestCustodySetup } from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  type TestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

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
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await getDb(env).batch([
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

async function requestInitialize(): Promise<Response> {
  return app.request(
    "/v1/wallets/initialize",
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

const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const CONFIG_ID = "cust_privy_byok_admission";
const CONNECTION_ID = "cconn_privy_byok_admission";
const CUSTODY_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

async function seedManagedPrivyConfig(): Promise<void> {
  await seedTestCustodySetup(
    env,
    {
      id: CONFIG_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      config: "managed",
      encryptionVersion: "test",
      status: "active",
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: "cwlt_privy_byok_admission",
      custodyConfigId: CONFIG_ID,
      walletId: "privy_wallet_admission",
      publicKey: "ManagedPublicKey",
      label: "Managed wallet",
      purpose: null,
      status: "active",
      createdAt: SEEDED_AT,
    }
  );
}

async function seedPendingPrivyConnection(): Promise<void> {
  const db = getDb(env);
  const credential: TestStoredProviderCredential = {
    id: "pcred_privy_byok_admission",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Stored Privy",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
    displayMetadata: {},
    status: "pending",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
  };
  await insertTestStoredProviderCredential(db, credential);
  await insertTestCustodyConnection(db, {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential,
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint: null,
    lastCheckStatus: null,
    lastCheckAt: null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
    createdAt: SEEDED_AT,
  });
}

async function connectionStatus(): Promise<{ status: string } | null> {
  return getDb(env)
    .prepare("SELECT status FROM custody_connections WHERE id = ?")
    .bind(CONNECTION_ID)
    .first<{ status: string }>();
}

describe("Managed Privy setup beside BYOK Privy", () => {
  const original = {
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedActor();
    env.PRIVY_APP_ID = "managed-app-id";
    env.PRIVY_APP_SECRET = "managed-app-secret";
    env.CUSTODY_ENCRYPTION_KEY = CUSTODY_ENCRYPTION_KEY;
  });

  afterEach(async () => {
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    await clearKVStores(env);
  });

  it("initializes a Managed Privy wallet in a project that also holds a pending Privy Connection", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "wallet_side_by_side",
      address: "ManagedSideBySidePublicKey",
    });
    await seedPendingPrivyConnection();

    const response = await requestInitialize();

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        configId: expect.any(String),
        walletId: "privy_wallet_side_by_side",
        publicKey: "ManagedSideBySidePublicKey",
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(
      await getDb(env)
        .prepare("SELECT project_id, provider, status FROM custody_configs WHERE id = ?")
        .bind(body.data.configId)
        .first()
    ).toEqual({ project_id: PROJECT_ID, provider: "privy", status: "active" });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(await connectionStatus()).toEqual({ status: "pending" });
  });

  it("keeps the initialize conflict for an active project Config", async () => {
    await seedManagedPrivyConfig();

    const response = await requestInitialize();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "CONFLICT",
        message: `Signing already initialized for org ${ORGANIZATION_ID} project ${PROJECT_ID}`,
      },
      meta: { requestId: expect.any(String) },
    });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
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
