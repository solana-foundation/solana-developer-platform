/**
 * API key revocation must invalidate cached authentication immediately.
 *
 * These tests warm the KV auth cache with an active entry, run the mutation
 * through the public API, and assert the very next request with the affected
 * key is rejected — no reliance on cache TTL expiry. They also cover the
 * stale-fill race: a cache fill computed from a pre-revocation DB read must
 * not resurrect a revoked key.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { apiKeyCacheKey, fillApiKeyCache, refreshApiKeyCache } from "@/lib/api-key-cache";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_api_key_revocation_cache",
  name: "API Key Revocation Cache Org",
  slug: "api-key-revocation-cache-org",
};

const TEST_PROJECT = {
  id: "prj_api_key_revocation_cache",
  slug: "test-api-key-revocation-cache",
};

const TEST_USER = {
  id: "usr_api_key_revocation_cache",
  email: "api-key-revocation-cache@example.com",
};

const ADMIN_KEY = {
  id: "key_revocation_cache_admin",
  raw: "sk_test_revocation_cache_admin",
  prefix: "sk_test_rev",
  name: "Admin key",
};

const TARGET_KEY = {
  id: "key_revocation_cache_target",
  raw: "sk_test_revocation_cache_target",
  prefix: "sk_test_rev",
  name: "Target key",
};

function cachedEntry(key: { id: string }): CachedApiKey {
  return {
    id: key.id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    status: "active",
    expiresAt: null,
    rotationDeadline: null,
  };
}

async function seedKeyRow(key: { id: string; name: string; hash: string }): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      key.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      key.name,
      "sk_test_rev",
      key.hash,
      "api_admin",
      JSON.stringify(["*"]),
      "active"
    )
    .run();
}

async function requestWithKey(raw: string): Promise<number> {
  const res = await app.request(
    "/v1/api-keys",
    {
      headers: { Authorization: `Bearer ${raw}` },
    },
    env
  );
  return res.status;
}

async function readCachedStatus(keyHash: string): Promise<string | undefined> {
  const kv = createKVStoreSet(env);
  const entry = await kv.apiKeys.get<CachedApiKey>(apiKeyCacheKey(keyHash), "json");
  return entry?.status;
}

describe("API key revocation cache invalidation", () => {
  let adminHash: string;
  let targetHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);

    adminHash = await hashString(ADMIN_KEY.raw, env.API_KEY_PEPPER);
    targetHash = await hashString(TARGET_KEY.raw, env.API_KEY_PEPPER);

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
    ]);

    await seedKeyRow({ id: ADMIN_KEY.id, name: ADMIN_KEY.name, hash: adminHash });
    await seedKeyRow({ id: TARGET_KEY.id, name: TARGET_KEY.name, hash: targetHash });

    // Warm the auth cache for both keys, as production traffic would.
    await seedCachedApiKey(env, adminHash, cachedEntry(ADMIN_KEY));
    await seedCachedApiKey(env, targetHash, cachedEntry(TARGET_KEY));
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("rejects a revoked key on the very next request despite a warm cache", async () => {
    expect(await requestWithKey(TARGET_KEY.raw)).toBe(200);

    const res = await app.request(
      `/v1/api-keys/${TARGET_KEY.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
        },
        body: JSON.stringify({ confirmation: TARGET_KEY.name }),
      },
      env
    );
    expect(res.status).toBe(200);

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
    // The cache holds the revoked state rather than an empty slot.
    expect(await readCachedStatus(targetHash)).toBe("deactivated");
  });

  it("does not let a stale fill resurrect a revoked key", async () => {
    await app.request(
      `/v1/api-keys/${TARGET_KEY.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
        },
        body: JSON.stringify({ confirmation: TARGET_KEY.name }),
      },
      env
    );

    // Simulate an in-flight auth fill whose DB read happened before the
    // revocation and whose cache write lands after it.
    const kv = createKVStoreSet(env);
    const adopted = await fillApiKeyCache(
      getDb(env),
      kv.apiKeys,
      targetHash,
      cachedEntry(TARGET_KEY)
    );

    // The losing fill must adopt the newer cached state for its own request
    // instead of proceeding on the stale active snapshot it read.
    expect(adopted.status).toBe("deactivated");
    expect(await readCachedStatus(targetHash)).toBe("deactivated");
    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
  });

  it("does not let a stale fill resurrect a hard-deleted key", async () => {
    // Ops-level hard delete (or an FK cascade): the row disappears entirely,
    // so the refresh has no authoritative state to write back.
    await getDb(env).prepare("DELETE FROM api_keys WHERE id = ?").bind(TARGET_KEY.id).run();

    const kv = createKVStoreSet(env);
    await refreshApiKeyCache(getDb(env), kv.apiKeys, targetHash);

    // A stale fill from a pre-delete DB read lands after the refresh. It
    // must not repopulate the slot with the active snapshot.
    const adopted = await fillApiKeyCache(
      getDb(env),
      kv.apiKeys,
      targetHash,
      cachedEntry(TARGET_KEY)
    );
    expect(adopted.status).not.toBe("active");

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
    expect(await readCachedStatus(targetHash)).toBe("revoked");
  });

  it("does not let a stale fill win its CAS against an evicted revocation entry", async () => {
    await app.request(
      `/v1/api-keys/${TARGET_KEY.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
        },
        body: JSON.stringify({ confirmation: TARGET_KEY.name }),
      },
      env
    );

    // Redis evicts the revocation's terminal entry (memory pressure) before
    // an in-flight fill — whose DB read predates the revocation — runs its
    // write-if-absent CAS. The empty slot lets the CAS win: the install must
    // not stand as authoritative for the next TTL.
    const kv = createKVStoreSet(env);
    await kv.apiKeys.delete(apiKeyCacheKey(targetHash));

    const adopted = await fillApiKeyCache(
      getDb(env),
      kv.apiKeys,
      targetHash,
      cachedEntry(TARGET_KEY)
    );

    expect(adopted.status).toBe("deactivated");
    expect(await readCachedStatus(targetHash)).toBe("deactivated");
    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
  });

  it("does not authenticate from a pending, unverified cache fill", async () => {
    // Freeze the middle of a fill: the pending install sits in the slot but
    // its Postgres verification has not completed — and the key is already
    // revoked in the DB (the exact eviction race the marker exists for). A
    // cache-hit reader must treat the pending entry as a miss and fall
    // through to Postgres.
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?")
      .bind(TARGET_KEY.id)
      .run();

    const kv = createKVStoreSet(env);
    await kv.apiKeys.put(
      apiKeyCacheKey(targetHash),
      JSON.stringify({
        ...cachedEntry(TARGET_KEY),
        organizationStatus: "active",
        pendingVerification: true,
      }),
      { expirationTtl: 3600 }
    );

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
  });

  it("re-asserts the cache when revoking an already-revoked key", async () => {
    // Simulate an earlier revocation that reached Postgres but crashed before
    // the cache write: DB says deactivated, cache still says active.
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'deactivated' WHERE id = ?")
      .bind(TARGET_KEY.id)
      .run();

    const res = await app.request(
      `/v1/api-keys/${TARGET_KEY.id}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
        },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBe(200);

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
    expect(await readCachedStatus(targetHash)).toBe("deactivated");
  });

  it("applies a shortened expiration immediately", async () => {
    const res = await app.request(
      `/v1/api-keys/${TARGET_KEY.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
        },
        body: JSON.stringify({ expiresAt: "2020-01-01T00:00:00.000Z" }),
      },
      env
    );
    expect(res.status).toBe(200);

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
  });

  it("invalidates every cached key before organization deletion returns", async () => {
    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(204);

    expect(await requestWithKey(TARGET_KEY.raw)).toBe(401);
    expect(await requestWithKey(ADMIN_KEY.raw)).toBe(401);
    expect(await readCachedStatus(targetHash)).toBe("revoked");
    expect(await readCachedStatus(adminHash)).toBe("revoked");
  });
});
