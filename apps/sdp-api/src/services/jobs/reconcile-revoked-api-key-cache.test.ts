/**
 * Regression test for the Hacktron finding: a malformed value in a revoked
 * key's cache slot made the reconciliation sweep throw from JSON.parse
 * (kv.get with "json" parses unguarded), crashing the whole cron run — and
 * with it the payment/custody reconciliation jobs that share the schedule —
 * for as long as the corrupted entry lived.
 *
 * The sweep must instead treat an unparseable entry like any other
 * divergence: replace it with the authoritative Postgres state and keep
 * going, so one bad value can never wedge the cron.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gauge for the sweep's Redis fan-out: tracks how many kv.get calls are in
// flight at once so the tests can prove the loop is not one-row-at-a-time.
const kvGauge = vi.hoisted(() => ({ inflightGets: 0, maxInflightGets: 0 }));

vi.mock("@/runtime/kv-redis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/runtime/kv-redis")>();

  type KVStore = ReturnType<typeof original.createKVStoreSet>["apiKeys"];

  const wrapStore = (store: KVStore): KVStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (...args: unknown[]) => {
            kvGauge.inflightGets += 1;
            kvGauge.maxInflightGets = Math.max(kvGauge.maxInflightGets, kvGauge.inflightGets);
            try {
              return await (target.get as (...inner: unknown[]) => Promise<unknown>).apply(
                target,
                args
              );
            } finally {
              kvGauge.inflightGets -= 1;
            }
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
import { apiKeyCacheKey } from "@/lib/api-key-cache";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import { reconcileRevokedApiKeyCache } from "./reconcile-revoked-api-key-cache";

const TEST_ORG = {
  id: "org_reconcile_sweep",
  name: "Reconcile Sweep Org",
  slug: "reconcile-sweep-org",
};

const TEST_PROJECT = { id: "prj_reconcile_sweep", slug: "test-reconcile-sweep" };
const TEST_USER = { id: "usr_reconcile_sweep", email: "reconcile-sweep@example.com" };

const CORRUPT_KEY = { id: "key_reconcile_corrupt", raw: "sk_test_reconcile_corrupt" };
const STALE_KEY = { id: "key_reconcile_stale", raw: "sk_test_reconcile_stale" };

function activeEntry(keyId: string): CachedApiKey {
  return {
    id: keyId,
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

async function seedRevokedKeyRow(keyId: string, keyHash: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'sk_test_rec', ?, 'api_admin', ?, 'revoked', datetime('now'))`
    )
    .bind(keyId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, keyId, keyHash, JSON.stringify(["*"]))
    .run();
}

describe("reconcileRevokedApiKeyCache", () => {
  let corruptHash: string;
  let staleHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);
    corruptHash = await hashString(CORRUPT_KEY.raw, env.API_KEY_PEPPER);
    staleHash = await hashString(STALE_KEY.raw, env.API_KEY_PEPPER);

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

    await seedRevokedKeyRow(CORRUPT_KEY.id, corruptHash);
    await seedRevokedKeyRow(STALE_KEY.id, staleHash);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("survives a corrupted cache entry and still repairs every divergent key", async () => {
    const kv = createKVStoreSet(env).apiKeys;

    // A corrupted (non-JSON) value in one revoked key's slot…
    await kv.put(apiKeyCacheKey(corruptHash), "not-json{", { expirationTtl: 3600 });
    // …and a stale active entry for another revoked key, seeded after the
    // corrupt one so the sweep must get past the corruption to reach it.
    await seedCachedApiKey(env, staleHash, activeEntry(STALE_KEY.id));

    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.scanned).toBe(2);
    expect(outcome.repaired).toBe(2);

    // Both slots now hold the authoritative revoked state.
    const repairedCorrupt = await kv.get<CachedApiKey>(apiKeyCacheKey(corruptHash), "json");
    const repairedStale = await kv.get<CachedApiKey>(apiKeyCacheKey(staleHash), "json");
    expect(repairedCorrupt?.status).toBe("revoked");
    expect(repairedStale?.status).toBe("revoked");

    // And a second sweep has nothing left to do.
    expect((await reconcileRevokedApiKeyCache(env)).repaired).toBe(0);
  });

  it("lands a rotated key's deadline in a cached entry that predates the rotation", async () => {
    // Rotation's handler never fails the request over its cache refresh
    // (the response carries the one-time replacement secret), so this sweep
    // is the durable path that makes the old key's cached entry pick up the
    // deadline once the store recovers.
    const rotatedKeyId = "key_reconcile_rotated";
    // Hashed only, never sent as a credential — no key-shaped prefix needed.
    const rotatedHash = await hashString("reconcile_rotated_raw", env.API_KEY_PEPPER);
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status, rotation_deadline)
         VALUES (?, ?, ?, ?, ?, 'sk_test_rec', ?, 'api_admin', ?, 'active', ?)`
      )
      .bind(
        rotatedKeyId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        rotatedKeyId,
        rotatedHash,
        JSON.stringify(["*"]),
        deadline
      )
      .run();
    // The cache still holds the pre-rotation entry: no deadline at all.
    await seedCachedApiKey(env, rotatedHash, activeEntry(rotatedKeyId));

    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.repaired).toBe(1);

    const repaired = await createKVStoreSet(env).apiKeys.get<CachedApiKey>(
      apiKeyCacheKey(rotatedHash),
      "json"
    );
    expect(repaired?.rotationDeadline).toBe(deadline);

    // Converged entries are cheap skips on the next tick.
    expect((await reconcileRevokedApiKeyCache(env)).repaired).toBe(0);
  });

  it("bounds the scan and fans out cache reads instead of one row at a time", async () => {
    // A bulk revocation: 40 keys, every one with a stale active cache entry.
    const hashes: string[] = [];
    for (let index = 0; index < 40; index++) {
      const keyId = `key_reconcile_bulk_${index}`;
      const hash = await hashString(`sk_test_reconcile_bulk_${index}`, env.API_KEY_PEPPER);
      hashes.push(hash);
      await seedRevokedKeyRow(keyId, hash);
      await seedCachedApiKey(env, hash, activeEntry(keyId));
    }

    kvGauge.inflightGets = 0;
    kvGauge.maxInflightGets = 0;

    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.repaired).toBe(40);
    // Sequential per-row awaits would never have more than one read in
    // flight; the chunked sweep must overlap them.
    expect(kvGauge.maxInflightGets).toBeGreaterThan(1);

    // The scan itself is bounded: with a limit below the backlog, one tick
    // processes exactly the limit and leaves the rest for the next tick.
    const limited = await reconcileRevokedApiKeyCache(env, { scanLimit: 10 });
    expect(limited.scanned).toBe(10);
  });
});
