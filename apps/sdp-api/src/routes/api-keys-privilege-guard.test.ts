import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_api_key_privilege",
  name: "API Key Privilege Org",
  slug: "api-key-privilege-org",
};

const TEST_PROJECT = { id: "prj_api_key_privilege", slug: "api-key-privilege-project" };
const TEST_USER = { id: "usr_api_key_privilege", email: "api-key-privilege@example.com" };

const WRITER_KEY = { id: "key_privilege_writer", raw: "sk_test_privilege_writer" };
const ADMIN_TARGET_KEY = { id: "key_privilege_admin_target", raw: "sk_test_privilege_admin" };
const READONLY_TARGET_KEY = { id: "key_privilege_ro_target", raw: "sk_test_privilege_ro" };

const WRITER_CACHED: CachedApiKey = {
  id: WRITER_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_developer",
  permissions: [
    "api-keys:read",
    "api-keys:write",
    "tokens:read",
    "payments:read",
    "earn:read",
    "counterparties:read",
    "wallets:read",
    "compliance:read",
    "webhooks:read",
    "audit:read",
  ],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

async function seedKeyRow(
  key: { id: string; raw: string },
  role: string,
  expiresAt: string | null
) {
  const keyHash = await hashString(key.raw, env.API_KEY_PEPPER);
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?)`
    )
    .bind(
      key.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      `Key ${key.id}`,
      key.raw.slice(0, 11),
      keyHash,
      role,
      expiresAt
    )
    .run();
}

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${WRITER_KEY.raw}`,
  };
}

describe("API key privilege guards", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await clearKVStores(env);

    const db = getDb(env);
    await db.prepare("DELETE FROM api_keys WHERE organization_id = ?").bind(TEST_ORG.id).run();
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Privilege Project', ?, 'sandbox', 'active', ?) ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id)
      .run();

    const writerHash = await hashString(WRITER_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, writerHash, WRITER_CACHED);
    await seedKeyRow(WRITER_KEY, "api_developer", null);
  });

  async function reseedActor() {
    const writerHash = await hashString(WRITER_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, writerHash, WRITER_CACHED);
  }

  it("refuses to rotate a key whose permissions exceed the actor's", async () => {
    await seedKeyRow(ADMIN_TARGET_KEY, "api_admin", null);
    await reseedActor();

    const res = await app.request(
      `/v1/api-keys/${ADMIN_TARGET_KEY.id}/rotate`,
      { method: "POST", headers: headers(), body: JSON.stringify({}) },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    const replacementCount = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM api_keys WHERE id <> ? AND id <> ?")
      .bind(WRITER_KEY.id, ADMIN_TARGET_KEY.id)
      .first<{ count: number }>();
    expect(replacementCount).toEqual({ count: 0 });
  });

  it("rotates a lesser key and carries its expiry onto the replacement", async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await seedKeyRow(READONLY_TARGET_KEY, "api_readonly", expiresAt);
    await reseedActor();

    const res = await app.request(
      `/v1/api-keys/${READONLY_TARGET_KEY.id}/rotate`,
      { method: "POST", headers: headers(), body: JSON.stringify({}) },
      env
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { apiKey: { id: string; expiresAt: string | null } };
    };
    expect(body.data.apiKey.id).not.toBe(READONLY_TARGET_KEY.id);
    expect(body.data.apiKey.expiresAt).toBe(expiresAt);

    const row = await getDb(env)
      .prepare("SELECT expires_at FROM api_keys WHERE id = ?")
      .bind(body.data.apiKey.id)
      .first<{ expires_at: string | null }>();
    expect(row?.expires_at).toBe(expiresAt);
  });

  it("refuses a wallet-scoped key granting a wallet outside its own scope", async () => {
    const scopedHash = await hashString("sk_test_privilege_scoped", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, scopedHash, {
      ...WRITER_CACHED,
      id: "key_privilege_scoped",
      walletScope: "selected",
      signingWalletIds: ["wal_scope_own"],
      walletBindings: [{ walletId: "wal_scope_own", permissions: ["*"] }],
    });

    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_test_privilege_scoped",
        },
        body: JSON.stringify({
          name: "Escaping key",
          role: "api_readonly",
          walletScope: "selected",
          signingWalletId: "wal_scope_other",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("outside your own wallet scope");
  });

  it("refuses a wallet-scoped key minting an all-wallets key", async () => {
    const scopedHash = await hashString("sk_test_privilege_scoped3", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, scopedHash, {
      ...WRITER_CACHED,
      id: "key_privilege_scoped3",
      walletScope: "selected",
      signingWalletIds: ["wal_scope_own"],
      walletBindings: [{ walletId: "wal_scope_own", permissions: ["*"] }],
    });

    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_test_privilege_scoped3",
        },
        body: JSON.stringify({
          name: "All wallets escape",
          role: "api_readonly",
          walletScope: "all",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("outside your own wallet scope");
  });

  it("lets a wallet-scoped key grant a wallet inside its own scope", async () => {
    const scopedHash = await hashString("sk_test_privilege_scoped2", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, scopedHash, {
      ...WRITER_CACHED,
      id: "key_privilege_scoped2",
      walletScope: "selected",
      signingWalletIds: ["wal_scope_own"],
      walletBindings: [{ walletId: "wal_scope_own", permissions: ["*"] }],
    });

    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_test_privilege_scoped2",
        },
        body: JSON.stringify({
          name: "Scoped key",
          role: "api_readonly",
          walletScope: "selected",
          signingWalletId: "wal_scope_own",
        }),
      },
      env
    );

    expect([200, 201, 400]).toContain(res.status);
    if (res.status === 403) {
      throw new Error("scope guard must not block a wallet the actor holds");
    }
  });

  it("refuses a wallet-scoped key rotating a key with broader wallet access", async () => {
    await seedKeyRow(READONLY_TARGET_KEY, "api_readonly", null);
    await getDb(env)
      .prepare("UPDATE api_keys SET signing_wallet_id = ? WHERE id = ?")
      .bind("wal_scope_other", READONLY_TARGET_KEY.id)
      .run();
    const scopedHash = await hashString("sk_test_privilege_scoped4", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, scopedHash, {
      ...WRITER_CACHED,
      id: "key_privilege_scoped4",
      walletScope: "selected",
      signingWalletIds: ["wal_scope_own"],
      walletBindings: [{ walletId: "wal_scope_own", permissions: ["*"] }],
    });

    const res = await app.request(
      `/v1/api-keys/${READONLY_TARGET_KEY.id}/rotate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_test_privilege_scoped4",
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("outside your own wallet scope");
    const replacement = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM api_keys WHERE rotated_from = ?")
      .bind(READONLY_TARGET_KEY.id)
      .first<{ count: number }>();
    expect(replacement).toEqual({ count: 0 });
  });

  it("refuses a wallet-scoped key provisioning a wallet", async () => {
    const scopedHash = await hashString("sk_test_privilege_scoped5", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, scopedHash, {
      ...WRITER_CACHED,
      id: "key_privilege_scoped5",
      permissions: [...WRITER_CACHED.permissions, "custody:admin"],
      walletScope: "selected",
      signingWalletIds: ["wal_scope_own"],
      walletBindings: [{ walletId: "wal_scope_own", permissions: ["*"] }],
    });

    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk_test_privilege_scoped5",
        },
        body: JSON.stringify({
          name: "Provisioned escape",
          role: "api_readonly",
          walletScope: "selected",
          provisionWallet: true,
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Cannot provision a wallet");
  });

  it("refuses a key updating its own record", async () => {
    await reseedActor();
    const res = await app.request(
      `/v1/api-keys/${WRITER_KEY.id}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ expiresAt: null }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("being used for this request");
  });
});
