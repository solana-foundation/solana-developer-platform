import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_api_key_wallet_scope",
  name: "API Key Wallet Scope Org",
  slug: "api-key-wallet-scope-org",
};

const TEST_PROJECT = {
  id: "prj_test_api_key_wallet_scope",
  slug: "test-api-key-wallet-scope-project",
};

const TEST_USER = {
  id: "usr_api_key_wallet_scope",
  email: "api-key-wallet-scope@example.com",
};

const TEST_API_KEY = {
  id: "key_api_key_wallet_scope",
  raw: "sk_test_api_key_wallet_scope",
  prefix: "sk_test_api",
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

const TEST_CONFIG_ID = "cust_cfg_api_key_wallet_scope";

async function seedAuthAndWallets(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
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
        "Admin test key",
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
        "local",
        "test-config",
        "sdp-custody-encryption-v1",
        "wal_scope_a",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind("csd_api_key_wallet_scope", TEST_ORG.id, null, TEST_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_scope_a",
        TEST_CONFIG_ID,
        "wal_scope_a",
        "pub_scope_a",
        "Wallet Scope A",
        "transfer",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_scope_b",
        TEST_CONFIG_ID,
        "wal_scope_b",
        "pub_scope_b",
        "Wallet Scope B",
        "transfer",
        "active"
      ),
  ]);
}

describe("API key wallet scope routes", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedAuthAndWallets();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("rejects create requests without walletScope", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          name: "Missing wallet scope",
          projectId: TEST_PROJECT.id,
        }),
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it("rejects wallet bindings when walletScope is all", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          name: "Conflicting all-wallet key",
          projectId: TEST_PROJECT.id,
          walletScope: "all",
          signingWalletId: "wal_scope_a",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("walletScope 'all'");
  });

  it("creates a selected-wallet key and persists wallet bindings", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          name: "Scoped key",
          projectId: TEST_PROJECT.id,
          walletScope: "selected",
          signingWalletId: "wal_scope_b",
          signingWalletIds: ["wal_scope_a", "wal_scope_b"],
        }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        apiKey: {
          id: string;
        };
      };
    };

    const created = await getDb(env)
      .prepare("SELECT signing_wallet_id FROM api_keys WHERE id = ?")
      .bind(body.data.apiKey.id)
      .first<{ signing_wallet_id: string | null }>();
    expect(created?.signing_wallet_id).toBe("wal_scope_b");

    const bindings = await getDb(env)
      .prepare(
        "SELECT wallet_id FROM api_key_wallet_permissions WHERE api_key_id = ? ORDER BY wallet_id"
      )
      .bind(body.data.apiKey.id)
      .all<{ wallet_id: string }>();
    expect(bindings.results?.map((row) => row.wallet_id)).toEqual(["wal_scope_a", "wal_scope_b"]);
  });

  it("lists wallet access and policy binding metadata for selected-wallet keys", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          name: "Scoped key with policy",
          projectId: TEST_PROJECT.id,
          walletScope: "selected",
          signingWalletId: "wal_scope_b",
          signingWalletIds: ["wal_scope_a", "wal_scope_b"],
        }),
      },
      env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        apiKey: {
          id: string;
        };
      };
    };
    const createdKeyId = body.data.apiKey.id;

    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profiles
             (id, organization_id, project_id, api_key_id, name, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "akcp_scope_a",
          TEST_ORG.id,
          TEST_PROJECT.id,
          createdKeyId,
          "Scoped policy",
          "active"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profile_revisions
             (id, profile_id, revision_number, rules, default_action, created_by, activated_at)
           VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`
        )
        .bind(
          "akcpr_scope_a_1",
          "akcp_scope_a",
          1,
          JSON.stringify([{ id: "allow_payments", kind: "always", action: "allow" }]),
          "allow",
          TEST_USER.id,
          "2026-06-29T00:00:00.000Z"
        ),
      getDb(env)
        .prepare(
          `UPDATE api_key_control_profiles
           SET active_revision_id = ?, activated_at = ?
           WHERE id = ?`
        )
        .bind("akcpr_scope_a_1", "2026-06-29T00:00:00.000Z", "akcp_scope_a"),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_policy_bindings
             (id, api_key_id, binding_scope, wallet_id, custody_wallet_id, api_key_control_profile_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "akwpol_scope_a",
          createdKeyId,
          "selected",
          "wal_scope_a",
          "cwlt_scope_a",
          "akcp_scope_a"
        ),
    ]);

    const listRes = await app.request(
      "/v1/api-keys",
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: {
        apiKeys: Array<{
          id: string;
          walletScope: string;
          signingWalletId: string | null;
          signingWalletIds: string[];
          walletBindings: Array<{ walletId: string }>;
          policyBindings: Array<{
            bindingScope: string;
            walletId: string | null;
            apiKeyControlProfileId: string | null;
            apiKeyControlProfileRevisionId: string | null;
          }>;
        }>;
      };
    };
    const listedKey = listBody.data.apiKeys.find((key) => key.id === createdKeyId);
    expect(listedKey).toMatchObject({
      walletScope: "selected",
      signingWalletId: "wal_scope_b",
      signingWalletIds: ["wal_scope_a", "wal_scope_b"],
    });
    expect(listedKey?.walletBindings.map((binding) => binding.walletId)).toEqual([
      "wal_scope_a",
      "wal_scope_b",
    ]);
    expect(listedKey?.policyBindings).toEqual([
      expect.objectContaining({
        bindingScope: "selected",
        walletId: "wal_scope_a",
        apiKeyControlProfileId: "akcp_scope_a",
        apiKeyControlProfileRevisionId: "akcpr_scope_a_1",
      }),
    ]);

    const detailRes = await app.request(
      `/v1/api-keys/${createdKeyId}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: {
        policyBindings: Array<{
          apiKeyControlProfileId: string | null;
          apiKeyControlProfileRevisionId: string | null;
        }>;
      };
    };
    expect(detailBody.data.policyBindings[0]).toMatchObject({
      apiKeyControlProfileId: "akcp_scope_a",
      apiKeyControlProfileRevisionId: "akcpr_scope_a_1",
    });
  });

  it("requires walletScope when updating wallet bindings", async () => {
    const res = await app.request(
      `/v1/api-keys/${TEST_API_KEY.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          signingWalletId: "wal_scope_a",
          signingWalletIds: ["wal_scope_a"],
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("walletScope is required");
  });

  it("clears wallet bindings when walletScope is updated to all", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare("UPDATE api_keys SET signing_wallet_id = ? WHERE id = ?")
        .bind("wal_scope_a", TEST_API_KEY.id),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES (?, ?, ?, ?)`
        )
        .bind("akw_scope_a", TEST_API_KEY.id, "wal_scope_a", JSON.stringify(["*"])),
    ]);

    const res = await app.request(
      `/v1/api-keys/${TEST_API_KEY.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          walletScope: "all",
        }),
      },
      env
    );

    expect(res.status).toBe(200);

    const updated = await getDb(env)
      .prepare("SELECT signing_wallet_id FROM api_keys WHERE id = ?")
      .bind(TEST_API_KEY.id)
      .first<{ signing_wallet_id: string | null }>();
    expect(updated?.signing_wallet_id).toBeNull();

    const bindings = await getDb(env)
      .prepare("SELECT COUNT(*) as count FROM api_key_wallet_permissions WHERE api_key_id = ?")
      .bind(TEST_API_KEY.id)
      .first<{ count: number }>();
    expect(bindings?.count).toBe(0);
  });
});
