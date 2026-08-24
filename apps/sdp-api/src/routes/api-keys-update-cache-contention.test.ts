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
 * Rotation inverts the second guarantee on purpose: its response carries the
 * replacement key's one-time secret, so failing the request over the old
 * key's cache refresh would push the caller into rotating again and minting
 * a second live credential. Rotation must deliver, and the reconciliation
 * sweep — not a client retry — repairs the old key's cached entry.
 *
 * Contention is simulated by mocking createKVStoreSet so compareAndSet on
 * `key:*` entries reports a lost race while armed — persistently, or for a
 * set number of calls.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kvContention = vi.hoisted(() => ({ contendApiKeyCas: false, loseCasRemaining: 0 }));

vi.mock("@/runtime/kv-redis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/kv-redis")>();

  type KVStore = ReturnType<typeof original.createKVStoreSet>["apiKeys"];

  const wrapStore = (store: KVStore): KVStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "compareAndSet") {
          return async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].startsWith("key:")) {
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
    await clearKVStores(env);
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

  it("delivers the rotation once even when the old key's cache refresh never lands", async () => {
    kvContention.contendApiKeyCas = true;

    const res = await app.request(
      `/v1/api-keys/${TARGET_KEY.id}/rotate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      env
    );

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

    // The store recovers; no client retry exists for rotation, so the
    // reconciliation sweep is what lands the old key's deadline in cache.
    kvContention.contendApiKeyCas = false;
    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.repaired).toBe(1);

    const row = await getDb(env)
      .prepare("SELECT rotation_deadline FROM api_keys WHERE id = ?")
      .bind(TARGET_KEY.id)
      .first<{ rotation_deadline: string | null }>();
    expect(row?.rotation_deadline).toBeTruthy();

    const targetHash = await hashString(TARGET_KEY.raw, env.API_KEY_PEPPER);
    const cached = await createKVStoreSet(env).apiKeys.get<CachedApiKey>(
      apiKeyCacheKey(targetHash),
      "json"
    );
    expect(cached?.rotationDeadline).toBe(row?.rotation_deadline);
  });
});
