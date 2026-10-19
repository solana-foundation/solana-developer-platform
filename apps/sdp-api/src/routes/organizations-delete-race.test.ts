import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";

const raceState = vi.hoisted(() => ({
  onBatch: null as null | (() => Promise<void>),
}));

vi.mock("@/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/db/client")>();
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

import { getDb } from "@/db/client";
import { app } from "@/index";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

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
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
       VALUES (?, ?, ?, ?, ?, 'sk_test_rac', ?, ?, 'active')`
    )
    .bind(keyId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, keyId, keyHash, ALL_API_KEY_GRANTS)
    .run();
}

function cachedEntry(keyId: string) {
  return {
    id: keyId,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    grants: ALL_API_KEY_GRANTS,
    environment: "sandbox" as const,
    rateLimitTier: "standard" as const,
    allowedIps: null,
    walletAccess: { scope: "all" } as const,
    status: "active" as const,
    expiresAt: null,
    rotationDeadline: null,
  };
}

describe("organization deletion vs concurrent API key creation", () => {
  let adminHash: string;
  let concurrentHash: string;
  let adminToken: string;

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
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
    });

    await seedKeyRow(ADMIN_KEY.id, adminHash);
    await seedApiKeyRow(env, adminHash, cachedEntry(ADMIN_KEY.id));
    // An organization is deleted by a signed-in admin, never a key (HOO-2099).
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('mem_delete_race_admin', ?, ?, 'admin', 'active')`
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();
    adminToken = await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id);
  });

  afterEach(async () => {
    raceState.onBatch = null;
    await clearKVStores(env);
  });

  it("refuses a key created between the hash snapshot and the revocation batch", async () => {
    // The "concurrent" creation lands right before the deletion batch
    // commits: the row exists, so the batch revokes it.
    raceState.onBatch = async () => {
      await seedKeyRow(CONCURRENT_KEY.id, concurrentHash);
      await seedApiKeyRow(env, concurrentHash, cachedEntry(CONCURRENT_KEY.id));
    };

    const res = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
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

    // …so it is refused on the very next request.
    const withConcurrentKey = await app.request(
      `/v1/organizations/${TEST_ORG.id}`,
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
        headers: { Authorization: `Bearer ${adminToken}` },
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
      `/v1/organizations/${TEST_ORG.id}`,
      { headers: { Authorization: `Bearer ${ESCAPED_KEY.raw}` } },
      env
    );
    expect(withEscapedKey.status).toBe(401);
  });
});
