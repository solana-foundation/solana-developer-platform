import { Buffer } from "node:buffer";
import { SigningError } from "@sdp/custody/signing";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { parseConfigRecord } from "@/services/domain/signing/provider-config";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionParaWalletMock = vi.spyOn(custodyProvisioning, "provisionParaWallet");

const TEST_CONFIG_ID = "cust_cfg_switch_test";
const TEST_ORG = {
  id: "org_custody_switch_test",
  name: "Custody Switch Test Org",
  slug: "custody-switch-test-org",
};
const TEST_PROJECT = {
  id: "prj_test_custody_switch",
  slug: "test-custody-switch-project",
};
const TEST_USER = {
  id: "usr_custody_switch_test",
  email: "custody-switch-test@example.com",
};
const TEST_API_KEY = {
  id: "key_custody_switch_test",
  raw: "sk_test_custody_switch",
  prefix: "sk_test_cus",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalParaApiKey: string | undefined;
let originalParaApiBaseUrl: string | undefined;
let originalCustodyEncryptionKey: string | undefined;

async function seedAuthAndActiveConfig(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Custody Switch Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_CONFIG_ID,
        TEST_ORG.id,
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "privy_wallet_test",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`csd_${TEST_CONFIG_ID}`, TEST_ORG.id, null, TEST_CONFIG_ID),
  ]);
}

describe("Custody switch rollback", () => {
  beforeEach(async () => {
    originalParaApiKey = env.PARA_API_KEY;
    originalParaApiBaseUrl = env.PARA_API_BASE_URL;
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.PARA_API_KEY = "para_test_api_key";
    env.PARA_API_BASE_URL = "https://trusted.para.test";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    vi.clearAllMocks();
    provisionParaWalletMock.mockRejectedValue(
      new SigningError("Forced para provisioning failure for rollback test", "NETWORK_ERROR")
    );
    await seedTestDatabase(env);
    await seedAuthAndActiveConfig();
  });

  afterEach(async () => {
    env.PARA_API_KEY = originalParaApiKey;
    env.PARA_API_BASE_URL = originalParaApiBaseUrl;
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("restores the previous active config when provider initialization fails", async () => {
    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "para",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");

    const configs = await getDb(env)
      .prepare(
        `SELECT id, provider, status
           FROM custody_configs
           WHERE organization_id = ? AND project_id IS NULL
           ORDER BY id`
      )
      .bind(TEST_ORG.id)
      .all<{ id: string; provider: string; status: string }>();

    expect(configs.results).toEqual([
      {
        id: TEST_CONFIG_ID,
        provider: "privy",
        status: "active",
      },
    ]);

    const paraConfigCount = await getDb(env)
      .prepare(
        `SELECT COUNT(*) as count
           FROM custody_configs
           WHERE organization_id = ? AND provider = 'para'`
      )
      .bind(TEST_ORG.id)
      .first<{ count: number }>();

    expect(Number(paraConfigCount?.count ?? 0)).toBe(0);

    const scopeDefault = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id IS NULL
         LIMIT 1`
      )
      .bind(TEST_ORG.id)
      .first<{ default_custody_config_id: string }>();

    expect(scopeDefault?.default_custody_config_id).toBe(TEST_CONFIG_ID);
  });

  it("ignores client endpoints and does not persist them when switching providers", async () => {
    provisionParaWalletMock.mockResolvedValue({
      walletId: "wal_para_trusted",
      address: "11111111111111111111111111111111",
      userIdentifier: "sdp-org_custody_switch_test",
      userIdentifierType: "CUSTOM_ID",
    });

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "para",
          apiBaseUrl: "https://untrusted.example",
        }),
      },
      env
    );

    expect(res.status).toBe(201);
    expect(provisionParaWalletMock).toHaveBeenCalledWith(
      env,
      expect.not.objectContaining({ apiBaseUrl: expect.anything() })
    );

    const record = await new CustodyConfigStore(getDb(env), env).findByProvider(
      TEST_ORG.id,
      TEST_PROJECT.id,
      "para"
    );
    expect(record).not.toBeNull();
    if (!record) {
      throw new Error("Expected the Para config to be persisted");
    }

    const parsed = await parseConfigRecord(env, TEST_ORG.id, record);
    expect(parsed).not.toHaveProperty("apiBaseUrl");
  });
});
