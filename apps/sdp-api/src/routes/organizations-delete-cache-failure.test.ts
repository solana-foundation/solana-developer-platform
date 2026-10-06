import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as kvRedis from "@/runtime/kv-redis";
import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const kvFailure = { failApiKeyWrites: false, failWritesRemaining: 0 };

const createKVStoreSet = kvRedis.createKVStoreSet;

function installCacheFailure() {
  type KVStore = ReturnType<typeof createKVStoreSet>["apiKeys"];
  const wrapStore = (store: KVStore): KVStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put" || prop === "compareAndSet") {
          return async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].startsWith("key:")) {
              if (kvFailure.failApiKeyWrites) {
                throw new Error("simulated redis outage");
              }
              if (kvFailure.failWritesRemaining > 0) {
                kvFailure.failWritesRemaining -= 1;
                throw new Error("simulated transient redis failure");
              }
            }
            return (target[prop] as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  vi.spyOn(kvRedis, "createKVStoreSet").mockImplementation((env) => {
    const set = createKVStoreSet(env);
    return { ...set, apiKeys: wrapStore(set.apiKeys) };
  });
}

const TEST_PROJECT = { id: "prj_delete_cache_failure", slug: "test-delete-cache-failure" };

const ADMIN_KEY = {
  id: "key_delete_cache_failure_admin",
  raw: "sk_test_delete_cache_failure_admin",
};

describe("organization deletion with failing cache invalidation", () => {
  let adminHash: string;
  beforeEach(async () => {
    installCacheFailure();
    await seedTestDatabase(env);
    adminHash = await hashString(ADMIN_KEY.raw, env.API_KEY_PEPPER);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(`INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, ?, 'sk_test_dcf', ?, 'api_admin', ?, 'active')`)
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
    kvFailure.failWritesRemaining = 0;
    vi.restoreAllMocks();
    await clearKVStores(env);
  });
  it("absorbs a transient cache failure and still invalidates before returning", async () => {
    kvFailure.failWritesRemaining = 1;
    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(204);
    const afterDeletion = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(afterDeletion.status).toBe(401);
  });
  it("repairs revoked keys left cached active by a failed deletion refresh", async () => {
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
    const row = await getDb(env)
      .prepare("SELECT status FROM api_keys WHERE id = ?")
      .bind(ADMIN_KEY.id)
      .first<{
        status: string;
      }>();
    expect(required(row).status).toBe("revoked");
    kvFailure.failApiKeyWrites = false;
    const duringWindow = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(duringWindow.status).toBe(200);
    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.repaired).toBe(1);
    const afterSweep = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(afterSweep.status).toBe(401);
    expect((await reconcileRevokedApiKeyCache(env)).repaired).toBe(0);
  });
});
