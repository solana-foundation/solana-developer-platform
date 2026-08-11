/**
 * Regression test for the Hacktron finding: an API key created concurrently
 * with organization deletion — after the handler snapshots the org's key
 * hashes but before the revocation batch commits — is revoked in Postgres by
 * the batch, yet its hash is missing from the snapshot, so its cached
 * "active" auth entry is never refreshed and keeps authenticating for the
 * full cache TTL.
 *
 * The interleaving is made deterministic by mocking @/db: getDb returns a
 * proxy whose batch() runs a one-shot hook (insert the "concurrent" key and
 * seed its cache, exactly what a fill from a pre-revocation DB read does)
 * before delegating to the real batch. On unpatched code (hash snapshot
 * taken before the batch) the key survives with a warm active cache; on
 * patched code (snapshot taken after the batch) it is refreshed to revoked.
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const raceState = vi.hoisted(() => ({
  onBatch: null as null | (() => Promise<void>),
}));

vi.mock("@/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/db")>();
  return {
    ...original,
    getDb: (bindings: Parameters<typeof original.getDb>[0]) => {
      const db = original.getDb(bindings);
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return async (statements: unknown[]) => {
              const hook = raceState.onBatch;
              raceState.onBatch = null;
              if (hook) {
                await hook();
              }
              return target.batch(statements as never);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_delete_race",
  name: "Delete Race Org",
  slug: "delete-race-org",
};

const TEST_PROJECT = { id: "prj_delete_race", slug: "test-delete-race" };
const TEST_USER = { id: "usr_delete_race", email: "delete-race@example.com" };

const ADMIN_KEY = {
  id: "key_delete_race_admin",
  raw: "sk_test_delete_race_admin",
};

const CONCURRENT_KEY = {
  id: "key_delete_race_concurrent",
  raw: "sk_test_delete_race_concurrent",
};

const ESCAPED_KEY = {
  id: "key_delete_race_escaped",
  raw: "sk_test_delete_race_escaped",
};

async function seedKeyRow(keyId: string, keyHash: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, 'sk_test_rac', ?, 'api_admin', ?, 'active')`
    )
    .bind(keyId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, keyId, keyHash, JSON.stringify(["*"]))
    .run();
}

function cachedEntry(keyId: string) {
  return {
    id: keyId,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin" as const,
    permissions: ["*" as const],
    environment: "sandbox" as const,
    rateLimitTier: "standard" as const,
    allowedIps: null,
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    status: "active" as const,
    expiresAt: null,
    rotationDeadline: null,
  };
}

describe("organization deletion vs concurrent API key creation", () => {
  let adminHash: string;
  let concurrentHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);
    adminHash = await hashString(ADMIN_KEY.raw, env.API_KEY_PEPPER);
    concurrentHash = await hashString(CONCURRENT_KEY.raw, env.API_KEY_PEPPER);

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

    await seedKeyRow(ADMIN_KEY.id, adminHash);
    await seedCachedApiKey(env, adminHash, cachedEntry(ADMIN_KEY.id));
  });

  afterEach(async () => {
    raceState.onBatch = null;
    await clearKVStores(env);
  });

  it("refreshes the cache of a key created between the hash snapshot and the revocation batch", async () => {
    // The "concurrent" creation lands right before the deletion batch
    // commits: the row exists (so the batch revokes it) and its cache entry
    // is active (as a fill from a pre-revocation DB read would leave it).
    raceState.onBatch = async () => {
      await seedKeyRow(CONCURRENT_KEY.id, concurrentHash);
      await seedCachedApiKey(env, concurrentHash, cachedEntry(CONCURRENT_KEY.id));
    };

    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(204);

    // The batch revoked the concurrent key in Postgres…
    const row = await getDb(env)
      .prepare("SELECT status FROM api_keys WHERE id = ?")
      .bind(CONCURRENT_KEY.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("revoked");

    // …so its cached credentials must be rejected on the very next request.
    const withConcurrentKey = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${CONCURRENT_KEY.raw}` } },
      env
    );
    expect(withConcurrentKey.status).toBe(401);
  });

  it("rejects a key that commits after the deletion's hash snapshot", async () => {
    // A key whose INSERT lands after the deletion handler snapshotted the
    // org's hashes is neither revoked by the batch's WHERE nor covered by the
    // refresh set. Authentication must reject it on the organization's status
    // rather than trusting the key's own row.
    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_KEY.raw}` },
      },
      env
    );
    expect(res.status).toBe(204);

    const escapedHash = await hashString(ESCAPED_KEY.raw, env.API_KEY_PEPPER);
    await seedKeyRow(ESCAPED_KEY.id, escapedHash);

    const row = await getDb(env)
      .prepare("SELECT status FROM api_keys WHERE id = ?")
      .bind(ESCAPED_KEY.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");

    const withEscapedKey = await app.request(
      "/v1/api-keys",
      { headers: { Authorization: `Bearer ${ESCAPED_KEY.raw}` } },
      env
    );
    expect(withEscapedKey.status).toBe(401);
  });
});
