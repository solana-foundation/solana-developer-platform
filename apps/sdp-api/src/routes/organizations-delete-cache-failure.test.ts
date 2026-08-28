/**
 * Regression tests for the Hacktron findings around organization deletion:
 * the DB batch commits first (org deleted, members removed, keys revoked),
 * and only then is the auth cache refreshed. A cache failure at that point
 * must not leave the org's keys authenticating from their cached "active"
 * entries with no way to repair the divergence.
 *
 * Two failure grades, two guarantees:
 * - A transient blip (a failed write that would succeed moments later) must
 *   be absorbed by the handler's own retries — the deletion still returns
 *   success only after every cached key is invalidated.
 * - A persistent outage cannot be invalidated synchronously (the cache is
 *   unreachable); the handler reports the failure and the credential-less
 *   reconciliation sweep repairs the divergence from the committed revoked
 *   rows once Redis recovers.
 *
 * The Redis outage is simulated by mocking createKVStoreSet so writes to
 * `key:*` entries reject while armed — persistently, or for a set number of
 * writes.
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kvFailure = vi.hoisted(() => ({ failApiKeyWrites: false, failWritesRemaining: 0 }));
const sessionFailure = vi.hoisted(() => ({ failRevoke: false }));

vi.mock("@/services/session.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/session.service")>();

  class IsolationTestSessionService extends original.SessionService {
    override async revokeOrganizationSessions(organizationId: string): Promise<void> {
      if (sessionFailure.failRevoke) {
        throw new Error("simulated session revocation failure");
      }
      return await super.revokeOrganizationSessions(organizationId);
    }
  }

  return { ...original, SessionService: IsolationTestSessionService };
});

vi.mock("@/runtime/kv-redis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/kv-redis")>();

  type KVStore = ReturnType<typeof original.createKVStoreSet>["apiKeys"];

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
    kvFailure.failWritesRemaining = 0;
    sessionFailure.failRevoke = false;
    await clearKVStores(env);
  });

  it("still invalidates cached keys when session revocation fails, and reports it", async () => {
    // Post-commit effects are isolated: the deletion is already committed,
    // so a failure in one must neither skip the others nor pass unreported.
    // A silently swallowed session revocation leaves dashboard sessions live
    // with nothing to retry it.
    sessionFailure.failRevoke = true;

    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(500);

    // The cache invalidation still ran to completion despite that failure.
    const afterDeletion = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(afterDeletion.status).toBe(401);
  });

  it("absorbs a transient cache failure and still invalidates before returning", async () => {
    // One failed write: the first refresh attempt loses, exactly the
    // "transient Redis connection issue or timeout" from the finding. The
    // handler must retry to completion instead of aborting into a committed
    // deletion whose keys keep authenticating.
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

    // The revoked state reached the cache before the handler answered.
    const afterDeletion = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` } },
      env
    );
    expect(afterDeletion.status).toBe(401);
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
