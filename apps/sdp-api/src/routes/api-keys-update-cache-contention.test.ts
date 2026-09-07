/**
 * Regression tests for silent CAS exhaustion on non-terminal cache refreshes:
 * a permission (or IP / expiry / wallet-scope) reduction whose cache refresh
 * loses every compare-and-set round must not report success while requests
 * keep authenticating against the older, broader cached authorization.
 *
 * Two guarantees, mirroring the organization-deletion failure tests:
 * - Transient contention (a burst of competing writes) is absorbed by the
 *   handler's retries — the update returns success only once the reduced
 *   authorization is what the cache serves.
 * - Sustained contention cannot be resolved synchronously; the handler
 *   reports a retriable failure instead of a success that leaves the old
 *   authorization live for the remaining cache TTL.
 *
 * Rotation cannot use either shape: its response carries the replacement
 * key's one-time secret, so a plain failure loses that secret, while a plain
 * success can leave the old key authorizing past its new deadline. It is
 * therefore all-or-nothing — the cache is probed before anything commits,
 * and an invalidation that fails afterwards rolls the rotation back so
 * Postgres matches what the cache still says.
 *
 * Contention is simulated by mocking createKVStoreSet so compareAndSet on
 * `key:*` entries reports a lost race while armed, and writes reject either
 * immediately or from the Nth call onward — the latter reproducing a store
 * that fails only after the pre-commit probe has already passed.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kvContention = vi.hoisted(() => ({
  contendApiKeyCas: false,
  loseCasRemaining: 0,
  failWrites: false,
  // Lets the pre-commit probe succeed and every write after it fail, which
  // is the one window the probe cannot cover.
  failWritesAfter: 0,
}));

vi.mock("@/runtime/kv-redis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/kv-redis")>();

  type KVStore = ReturnType<typeof original.createKVStoreSet>["apiKeys"];

  const wrapStore = (store: KVStore): KVStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "put" || prop === "delete" || prop === "compareAndSet") {
          return async (...args: unknown[]) => {
            // Reads keep working: a store refusing writes while serving
            // reads is what leaves stale authorization usable.
            if (kvContention.failWrites) {
              throw new Error("simulated redis write outage");
            }
            if (kvContention.failWritesAfter > 0) {
              kvContention.failWritesAfter -= 1;
              if (kvContention.failWritesAfter === 0) {
                kvContention.failWrites = true;
              }
            }
            if (
              prop === "compareAndSet" &&
              typeof args[0] === "string" &&
              args[0].startsWith("key:")
            ) {
              if (kvContention.contendApiKeyCas) {
                return false;
              }
              if (kvContention.loseCasRemaining > 0) {
                kvContention.loseCasRemaining -= 1;
                return false;
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
import { apiKeyCacheKey } from "@/lib/api-key-cache";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { ApiKeyService } from "@/services/api-key.service";
import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_update_cache_contention",
  name: "Update Cache Contention Org",
  slug: "update-cache-contention-org",
};

const TEST_PROJECT = { id: "prj_update_cache_contention", slug: "test-update-cache-contention" };
const TEST_USER = { id: "usr_update_cache_contention", email: "update-contention@example.com" };

const ADMIN_KEY = {
  id: "key_update_contention_admin",
  raw: "sk_test_update_contention_admin",
  name: "Admin key",
};

const TARGET_KEY = {
  id: "key_update_contention_target",
  raw: "sk_test_update_contention_target",
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
      "sk_test_ucc",
      key.hash,
      "api_admin",
      JSON.stringify(["*"]),
      "active"
    )
    .run();
}

async function reduceTargetPermissions(): Promise<number> {
  const res = await app.request(
    `/v1/api-keys/${TARGET_KEY.id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY.raw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissions: ["projects:read"] }),
    },
    env
  );
  return res.status;
}

/** List API keys with the target key: allowed under "*", denied afterwards. */
async function targetKeyListStatus(): Promise<number> {
  const res = await app.request(
    "/v1/api-keys",
    { headers: { Authorization: `Bearer ${TARGET_KEY.raw}` } },
    env
  );
  return res.status;
}

describe("API key update with contended cache refresh", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    const adminHash = await hashString(ADMIN_KEY.raw, env.API_KEY_PEPPER);
    const targetHash = await hashString(TARGET_KEY.raw, env.API_KEY_PEPPER);

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
    ]);

    await seedKeyRow({ id: ADMIN_KEY.id, name: ADMIN_KEY.name, hash: adminHash });
    await seedKeyRow({ id: TARGET_KEY.id, name: TARGET_KEY.name, hash: targetHash });

    // Warm the auth cache for both keys, as production traffic would.
    await seedCachedApiKey(env, adminHash, cachedEntry(ADMIN_KEY));
    await seedCachedApiKey(env, targetHash, cachedEntry(TARGET_KEY));
  });

  afterEach(async () => {
    kvContention.contendApiKeyCas = false;
    kvContention.loseCasRemaining = 0;
    kvContention.failWrites = false;
    kvContention.failWritesAfter = 0;
    await clearKVStores(env);
  });

  it("rolls the rotation back when the store fails after the pre-commit probe", async () => {
    // The probe passes, then the store stops accepting writes before the
    // post-commit invalidation. The cached entry therefore still describes
    // the pre-rotation key — active, no deadline — and every repair path is
    // blocked on that same store. Returning the secret here would leave the
    // old key usable past its deadline, so the rotation is undone instead.
    // The probe's own write is what arms the failure.
    kvContention.failWritesAfter = 1;

    const res = await rotateTargetKey({ gracePeriodHours: 0 });
    expect(res.status).toBe(503);

    // Postgres now matches what the cache still says: the old key is active
    // with no deadline, so the stale entry is no longer stale.
    const row = await getDb(env)
      .prepare("SELECT status, rotation_deadline FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ status: string; rotation_deadline: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.rotation_deadline).toBeNull();

    // The replacement nobody received a secret for is retired, so no live
    // orphan is left behind.
    const liveReplacements = await getDb(env)
      .prepare(
        "SELECT COUNT(*) AS count FROM api_keys WHERE rotated_from = ? AND status = 'active'"
      )
      .bind(TARGET_KEY.id)
      .first<{ count: number }>();
    expect(Number(liveReplacements?.count)).toBe(0);

    // The old key still works, which is correct: the rotation never applied.
    kvContention.failWrites = false;
    expect(await targetKeyListStatus()).toBe(200);

    // And the retry is admitted rather than refused as a duplicate.
    expect((await rotateTargetKey({ gracePeriodHours: 0 })).status).toBe(201);
    expect(await targetKeyListStatus()).toBe(401);
  });

  it("retries a rollback that fails transiently instead of leaving the deadline uncached", async () => {
    // Same window as above, plus a Postgres blip on the first undo. Conceding
    // after one attempt would commit the one state nothing can repair:
    // Postgres carrying a rotation deadline the cached entry does not know
    // about, which lets the old secret authenticate past it for the entry's
    // full TTL — the sweep cannot help, it writes to the same dead cache.
    const undoRotation = ApiKeyService.prototype.undoRotation;
    let undoAttempts = 0;
    const undoSpy = vi
      .spyOn(ApiKeyService.prototype, "undoRotation")
      .mockImplementation(async function (this: ApiKeyService, ...args) {
        undoAttempts += 1;
        if (undoAttempts === 1) {
          throw new Error("simulated transient postgres failure");
        }
        return await undoRotation.apply(this, args);
      });

    try {
      kvContention.failWritesAfter = 1;

      const res = await rotateTargetKey({ gracePeriodHours: 0 });
      expect(res.status).toBe(503);
      expect(undoAttempts).toBeGreaterThan(1);

      // The retry landed the undo, so Postgres again matches the stale entry.
      const row = await getDb(env)
        .prepare("SELECT status, rotation_deadline FROM api_keys WHERE id = ?")
        .bind(TARGET_KEY.id)
        .first<{ status: string; rotation_deadline: string | null }>();
      expect(row?.status).toBe("active");
      expect(row?.rotation_deadline).toBeNull();

      const liveReplacements = await getDb(env)
        .prepare(
          "SELECT COUNT(*) AS count FROM api_keys WHERE rotated_from = ? AND status = 'active'"
        )
        .bind(TARGET_KEY.id)
        .first<{ count: number }>();
      expect(Number(liveReplacements?.count)).toBe(0);
    } finally {
      undoSpy.mockRestore();
    }
  });

  it("refuses to rotate at all while the cache cannot accept the invalidation", async () => {
    // Writes are refused but reads still work, so a committed rotation would
    // leave the old key's entry authorizing past its deadline with no
    // recovery: the refresh, the fallback drop and the reconciliation sweep
    // all write to this same store. Rotation cannot be rolled back, cannot
    // fail its response, and cannot be retried, so it must not start.
    kvContention.failWrites = true;

    const res = await rotateTargetKey({ gracePeriodHours: 0 });
    expect(res.status).toBe(503);

    // Nothing was committed: no replacement key, no deadline on the old one.
    const row = await getDb(env)
      .prepare("SELECT rotation_deadline FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ rotation_deadline: string | null }>();
    expect(row?.rotation_deadline).toBeNull();

    const replacements = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE rotated_from = ?")
      .bind(TARGET_KEY.id)
      .first<{ count: number }>();
    expect(Number(replacements?.count)).toBe(0);

    // The store recovers and the same request succeeds, with nothing to undo.
    kvContention.failWrites = false;
    expect((await rotateTargetKey({ gracePeriodHours: 0 })).status).toBe(201);
    expect(await targetKeyListStatus()).toBe(401);
  });

  it("absorbs transient contention and serves the reduced authorization before success", async () => {
    // The refresh's first CAS loop exhausts (3 losses) and the retry loses
    // once more before landing: both retry layers are exercised, and success
    // is only reported once the cache reflects the reduction.
    kvContention.loseCasRemaining = 4;

    expect(await reduceTargetPermissions()).toBe(200);
    expect(await targetKeyListStatus()).toBe(403);
  });

  it("reports failure instead of success while the broader authorization stays cached", async () => {
    kvContention.contendApiKeyCas = true;

    expect(await reduceTargetPermissions()).toBe(500);

    // The reduction committed to Postgres regardless.
    const row = await getDb(env)
      .prepare("SELECT permissions FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ permissions: string }>();
    expect(JSON.parse(row?.permissions ?? "[]")).toEqual(["projects:read"]);

    // Contention clears — but nothing has repaired the cache yet, so the old
    // broad authorization is still what authenticates. The 500 above is what
    // tells the caller this state exists and the request must be retried.
    kvContention.contendApiKeyCas = false;
    expect(await targetKeyListStatus()).toBe(200);

    // The retried update converges and the reduction takes effect.
    expect(await reduceTargetPermissions()).toBe(200);
    expect(await targetKeyListStatus()).toBe(403);
  });

  async function rotateTargetKey(body: Record<string, unknown> = {}): Promise<Response> {
    return await app.request(
      `/v1/api-keys/${TARGET_KEY.id}/rotate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  it("stops the old secret at an immediate deadline the refresh could not cache", async () => {
    // gracePeriodHours: 0 means the old key is done the moment the rotation
    // commits. Rotation cannot fail its request over a cache write, so a
    // contended refresh used to leave the pre-rotation entry standing with
    // rotationDeadline: null — and the middleware reads the deadline solely
    // from the cache, so the old secret kept working until the sweep ran.
    kvContention.contendApiKeyCas = true;

    expect((await rotateTargetKey({ gracePeriodHours: 0 })).status).toBe(201);

    const row = await getDb(env)
      .prepare("SELECT rotation_deadline FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ rotation_deadline: string | null }>();
    expect(row?.rotation_deadline).toBeTruthy();

    // No sweep, no client retry: the very next request must already be
    // refused, because the unwritable entry was dropped rather than left to
    // authorize past the deadline.
    expect(await targetKeyListStatus()).toBe(401);
  });

  it("refuses to mint a second live key when one replacement already exists", async () => {
    // Rotation is a create: its secret exists only in the response that
    // minted it. A repeated attempt — a retry after a lost response, or a
    // concurrent duplicate — must not leave behind a second live key that
    // nobody holds the secret for and nothing distinguishes from a real one.
    const first = await rotateTargetKey();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { apiKey: { id: string } } };

    const retry = await rotateTargetKey();
    expect(retry.status).toBe(409);
    // The conflict names the replacement so an operator who never received
    // the first secret can find and revoke that exact key.
    expect(await retry.text()).toContain(firstBody.data.apiKey.id);

    const replacements = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE rotated_from = ?")
      .bind(TARGET_KEY.id)
      .first<{ count: number }>();
    expect(Number(replacements?.count)).toBe(1);

    // Once that replacement is retired, rotating the key again is allowed.
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?")
      .bind(firstBody.data.apiKey.id)
      .run();
    expect((await rotateTargetKey()).status).toBe(201);
  });

  it("delivers the rotation once even when the old key's cache refresh never lands", async () => {
    kvContention.contendApiKeyCas = true;

    const res = await rotateTargetKey();

    // The one-time secret must be delivered despite the failed refresh: a
    // 500 would push the caller into rotating again, minting a second live
    // credential while this one's secret is lost with the error response.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { apiKey: { key?: string } } };
    expect(body.data.apiKey.key).toBeTruthy();

    // Exactly one replacement key was created.
    const replacements = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE rotated_from = ?")
      .bind(TARGET_KEY.id)
      .first<{ count: number }>();
    expect(Number(replacements?.count)).toBe(1);

    // The unwritable entry was dropped rather than left reporting no
    // deadline, so nothing stale survives the request that could not write.
    const targetHash = await hashString(TARGET_KEY.raw, env.API_KEY_PEPPER);
    const kv = createKVStoreSet(env).apiKeys;
    expect(await kv.get(apiKeyCacheKey(targetHash))).toBeNull();

    // A miss, so the next request re-reads Postgres and caches the real
    // deadline — no sweep and no client retry involved.
    kvContention.contendApiKeyCas = false;
    expect(await targetKeyListStatus()).toBe(200);

    const row = await getDb(env)
      .prepare("SELECT rotation_deadline FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ rotation_deadline: string | null }>();
    expect(row?.rotation_deadline).toBeTruthy();

    const cached = await kv.get<CachedApiKey>(apiKeyCacheKey(targetHash), "json");
    expect(cached?.rotationDeadline).toBe(row?.rotation_deadline);

    // And the sweep has nothing left to repair for this key.
    expect((await reconcileRevokedApiKeyCache(env)).repaired).toBe(0);
  });
});
