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
import app from "@/index";
import { apiKeyCacheKey } from "@/lib/api-key-cache";
import { isRotationDeadlineReached } from "@/lib/api-key-rotation";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import {
  ROTATED_DEADLINE_CURSOR_CACHE_KEY,
  reconcileRevokedApiKeyCache,
} from "./reconcile-revoked-api-key-cache";

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
    await clearKVStores(env);
    corruptHash = await hashString(CORRUPT_KEY.raw, env.API_KEY_PEPPER);
    staleHash = await hashString(STALE_KEY.raw, env.API_KEY_PEPPER);

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

  it("tombstones the cached entry of a key whose project was dropped", async () => {
    const kv = createKVStoreSet(env).apiKeys;
    const droppedHash = await hashString("sk_test_reconcile_dropped", env.API_KEY_PEPPER);
    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES ('key_reconcile_dropped', ?, ?, ?, 'dropped', 'sk_test_rec', ?, 'api_admin', ?, 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, droppedHash, JSON.stringify(["*"]))
      .run();
    await seedCachedApiKey(env, droppedHash, activeEntry("key_reconcile_dropped"));

    await getDb(env).batch([
      getDb(env).prepare("DELETE FROM api_keys WHERE project_id = ?").bind(TEST_PROJECT.id),
      getDb(env).prepare("DELETE FROM projects WHERE id = ?").bind(TEST_PROJECT.id),
    ]);

    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.scanned).toBe(1);
    expect(outcome.repaired).toBe(1);

    const tombstoned = await kv.get<CachedApiKey>(apiKeyCacheKey(droppedHash), "json");
    expect(tombstoned?.status).toBe("revoked");

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

/**
 * Regression tests for the Apex finding SOLA9-554: the rotated scan pages
 * active rows by `rotation_deadline` with LIMIT before any Redis read, so a
 * converged row occupying the top of the ordering is reselected on every
 * sweep while a later stale row is never inspected — and the former bearer
 * keeps authenticating from its pre-rotation cache snapshot.
 *
 * The rotated worklist must make progress: every eligible row is eventually
 * inspected no matter how many converged rows sit ahead of it.
 */
describe("rotated scan starvation (SOLA9-554)", () => {
  const STARVATION_ORG = {
    id: "org_rotated_starvation",
    name: "Rotated Starvation Org",
    slug: "rotated-starvation-org",
  };
  const STARVATION_PROJECT = { id: "prj_rotated_starvation", slug: "rotated-starvation" };
  const STARVATION_USER = { id: "usr_rotated_starvation", email: "rotated-starvation@example.com" };

  const BLOCKER = { id: "key_rotated_blocker", raw: "sk_test_rotated_blocker" };
  const TARGET = { id: "key_rotated_target", raw: "sk_test_rotated_target" };

  function starvationEntry(keyId: string, rotationDeadline: string | null): CachedApiKey {
    return {
      id: keyId,
      organizationId: STARVATION_ORG.id,
      projectId: STARVATION_PROJECT.id,
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
      rotationDeadline,
    };
  }

  async function seedActiveRotatedKey(
    key: { id: string; raw: string },
    rotationDeadline: string
  ): Promise<string> {
    const hash = await hashString(key.raw, env.API_KEY_PEPPER);
    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status, rotation_deadline)
         VALUES (?, ?, ?, ?, ?, 'sk_test_rot', ?, 'api_admin', ?, 'active', ?)`
      )
      .bind(
        key.id,
        STARVATION_ORG.id,
        STARVATION_PROJECT.id,
        STARVATION_USER.id,
        key.id,
        hash,
        JSON.stringify(["*"]),
        rotationDeadline
      )
      .run();
    return hash;
  }

  /** The cache entry a rotation's failed post-commit write leaves behind. */
  async function seedStalePreRotationEntry(keyId: string, keyHash: string): Promise<void> {
    await seedCachedApiKey(env, keyHash, starvationEntry(keyId, null));
  }

  /** Probe through the real app so auth runs exactly as deployed. */
  function authenticate(rawKey: string) {
    return app.request(
      `/v1/organizations/${STARVATION_ORG.id}`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
      env
    );
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(STARVATION_ORG.id, STARVATION_ORG.name, STARVATION_ORG.slug, "individual", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(STARVATION_USER.id, STARVATION_USER.email, 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: STARVATION_ORG.id,
      createdBy: STARVATION_USER.id,
      members: [],
      ids: { sandbox: STARVATION_PROJECT.id, production: `${STARVATION_PROJECT.id}_production` },
    });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("advances past a converged rotated row to inspect and repair a later deadline entry", async () => {
    // The blocker: deadline in the future, cache entry already carries it —
    // converged, and selected first by the newest-deadline ordering.
    const blockerDeadline = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const blockerHash = await seedActiveRotatedKey(BLOCKER, blockerDeadline);
    await seedCachedApiKey(env, blockerHash, starvationEntry(BLOCKER.id, blockerDeadline));

    // The target: deadline already reached in Postgres, but the cache still
    // holds the pre-rotation snapshot with no deadline at all — the sweep's
    // one durable path to untrust the former bearer.
    const targetDeadline = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const targetHash = await seedActiveRotatedKey(TARGET, targetDeadline);
    await seedStalePreRotationEntry(TARGET.id, targetHash);

    // One row per sweep: the first tick inspects only the converged blocker.
    const firstSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(firstSweep.scanned).toBe(1);
    expect(firstSweep.repaired).toBe(0);

    // The next tick must resume after the blocker instead of reselecting it
    // forever: the target is inspected and its stale entry repaired.
    const secondSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(secondSweep.scanned).toBe(1);
    expect(secondSweep.repaired).toBe(1);

    const kv = createKVStoreSet(env).apiKeys;
    const targetCache = await kv.get<CachedApiKey>(apiKeyCacheKey(targetHash), "json");
    expect(targetCache?.rotationDeadline).toBe(targetDeadline);

    // Negative control: the converged blocker is left untouched.
    const blockerCache = await kv.get<CachedApiKey>(apiKeyCacheKey(blockerHash), "json");
    expect(blockerCache?.rotationDeadline).toBe(blockerDeadline);

    // The former bearer is no longer trusted: the authoritative deadline is
    // reached, and cache-hit auth must agree with Postgres.
    expect(isRotationDeadlineReached(targetCache?.rotationDeadline)).toBe(true);
    const rejected = await authenticate(TARGET.raw);
    expect(rejected.status).toBe(401);

    // Supported flow preserved: the blocker's own bearer still authenticates
    // — its deadline is genuinely in the future and its cache is converged.
    const stillAuthorized = await authenticate(BLOCKER.raw);
    expect(stillAuthorized.status).toBe(200);
  });

  it("tie-breaks same-deadline rows by key hash so a tie cannot hide a stale row", async () => {
    // Identical deadline strings: only the (deadline, key_hash) tuple makes
    // the worklist order deterministic enough to resume from.
    const sharedDeadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const first = { id: "key_rotated_tie_a", raw: "sk_test_rotated_tie_a" };
    const second = { id: "key_rotated_tie_b", raw: "sk_test_rotated_tie_b" };
    const firstHash = await seedActiveRotatedKey(first, sharedDeadline);
    const secondHash = await seedActiveRotatedKey(second, sharedDeadline);
    await seedStalePreRotationEntry(first.id, firstHash);
    await seedStalePreRotationEntry(second.id, secondHash);

    // One row per sweep; each sweep must repair a different row, so both
    // stale entries are repaired within two ticks.
    const firstSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(firstSweep.repaired).toBe(1);
    const secondSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(secondSweep.repaired).toBe(1);

    const kv = createKVStoreSet(env).apiKeys;
    const firstCache = await kv.get<CachedApiKey>(apiKeyCacheKey(firstHash), "json");
    const secondCache = await kv.get<CachedApiKey>(apiKeyCacheKey(secondHash), "json");
    expect(firstCache?.rotationDeadline).toBe(sharedDeadline);
    expect(secondCache?.rotationDeadline).toBe(sharedDeadline);
  });

  it("resets its resume position after draining the rotated worklist", async () => {
    const blockerDeadline = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const blockerHash = await seedActiveRotatedKey(BLOCKER, blockerDeadline);
    await seedCachedApiKey(env, blockerHash, starvationEntry(BLOCKER.id, blockerDeadline));

    // Tick 1 inspects the blocker and parks after it; tick 2 finds nothing
    // below (the cursor must have actually advanced); tick 3 starts from the
    // newest deadline again, so rows landing ahead of the resume position are
    // never stranded behind it.
    const firstSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(firstSweep.scanned).toBe(1);
    const secondSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(secondSweep.scanned).toBe(0);
    const thirdSweep = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(thirdSweep.scanned).toBe(1);
    expect(thirdSweep.repaired).toBe(0);
  });

  it("leaves a rotated row with no cache entry as a safe miss", async () => {
    // Cache-miss safety is load-bearing: an empty slot must stay empty (the
    // next request re-reads Postgres through the verified fill path) — the
    // sweep must never install non-terminal state into it.
    const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const keyHash = await seedActiveRotatedKey(TARGET, deadline);

    const outcome = await reconcileRevokedApiKeyCache(env);
    expect(outcome.scanned).toBe(1);
    expect(outcome.repaired).toBe(0);

    const slot = await createKVStoreSet(env).apiKeys.get(apiKeyCacheKey(keyHash));
    expect(slot).toBeNull();
  });

  it("treats a malformed persisted cursor as absent", async () => {
    // A corrupted cursor must degrade to the pre-cursor behavior (start from
    // the newest deadline), never crash the cron or wedge the worklist.
    const deadline = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const targetHash = await seedActiveRotatedKey(TARGET, deadline);
    await seedStalePreRotationEntry(TARGET.id, targetHash);
    await createKVStoreSet(env).apiKeys.put(ROTATED_DEADLINE_CURSOR_CACHE_KEY, "not-json{");

    const outcome = await reconcileRevokedApiKeyCache(env, { scanLimit: 1 });
    expect(outcome.scanned).toBe(1);
    expect(outcome.repaired).toBe(1);

    const repaired = await createKVStoreSet(env).apiKeys.get<CachedApiKey>(
      apiKeyCacheKey(targetHash),
      "json"
    );
    expect(repaired?.rotationDeadline).toBe(deadline);
  });
});
