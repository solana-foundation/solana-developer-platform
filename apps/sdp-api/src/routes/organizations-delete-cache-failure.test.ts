/**
 * Regression test for the Hacktron finding: when the post-commit cache
 * refresh fails during organization deletion (transient Redis outage), the
 * deletion has already committed — the organization's keys are revoked in
 * Postgres and the admin's credentials are gone — yet the keys keep
 * authenticating from their cached "active" entries for the rest of the
 * cache TTL, with no client-side way to repair the divergence.
 *
 * The Redis outage is simulated by mocking createKVStoreSet so writes to
 * `key:*` entries reject while armed. The test first reproduces the
 * vulnerable window (a DB-revoked key still gets 200 after the failed
 * deletion), then proves the reconciliation sweep repairs it without any
 * request credentials. On unpatched code this file fails: the reconciler
 * module does not exist, and nothing else ever flips the 200 to a 401.
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kvFailure = vi.hoisted(() => ({ failApiKeyWrites: false }));

vi.mock("@/runtime/kv-redis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/kv-redis")>();

  type KVStore = ReturnType<typeof original.createKVStoreSet>["apiKeys"];

  const wrapStore = (store: KVStore): KVStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put" || prop === "compareAndSet") {
          return async (...args: unknown[]) => {
            if (
              kvFailure.failApiKeyWrites &&
              typeof args[0] === "string" &&
              args[0].startsWith("key:")
            ) {
              throw new Error("simulated redis outage");
            }
            return (target[prop] as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return {
    ...original,
    createKVStoreSet: (env: Parameters<typeof original.createKVStoreSet>[0]) => {
      const set = original.createKVStoreSet(env);
      return { ...set, apiKeys: wrapStore(set.apiKeys) };
    },
  };
});

import { getDb } from "@/db";
import app from "@/index";
import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_delete_cache_failure",
  name: "Delete Cache Failure Org",
  slug: "delete-cache-failure-org",
};

const TEST_PROJECT = { id: "prj_delete_cache_failure", slug: "test-delete-cache-failure" };
const TEST_USER = { id: "usr_delete_cache_failure", email: "delete-cache-failure@example.com" };

const ADMIN_KEY = {
  id: "key_delete_cache_failure_admin",
  raw: "sk_test_delete_cache_failure_admin",
};

describe("organization deletion with failing cache invalidation", () => {
  let adminHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);
    adminHash = await hashString(ADMIN_KEY.raw, env.API_KEY_PEPPER);

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
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, ?, 'sk_test_dcf', ?, 'api_admin', ?, 'active')`
        )
        .bind(
          ADMIN_KEY.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          ADMIN_KEY.id,
          adminHash,
          JSON.stringify(["*"])
        ),
    ]);

    await seedCachedApiKey(env, adminHash, {
      id: ADMIN_KEY.id,
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
    });
  });

  afterEach(async () => {
    kvFailure.failApiKeyWrites = false;
    await clearKVStores(env);
  });

  it("repairs revoked keys left cached active by a failed deletion refresh", async () => {
    // Redis starts failing writes right as the deletion runs.
    kvFailure.failApiKeyWrites = true;
    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(500);

    // The deletion committed regardless: the key is revoked in Postgres.
    const row = await getDb(env)
      .prepare("SELECT status FROM api_keys WHERE id = ?")
      .bind(ADMIN_KEY.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("revoked");

    // Redis recovers — but nothing in the request path repairs the cache.
    kvFailure.failApiKeyWrites = false;

    // Reproduced vulnerable window: the revoked key still authenticates.
    const duringWindow = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(duringWindow.status).toBe(200);

    // The credential-less reconciliation sweep repairs the divergence.
    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.repaired).toBe(1);

    const afterSweep = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(afterSweep.status).toBe(401);

    // A second sweep finds nothing left to repair.
    expect((await reconcileRevokedApiKeyCache(env)).repaired).toBe(0);
  });
});
