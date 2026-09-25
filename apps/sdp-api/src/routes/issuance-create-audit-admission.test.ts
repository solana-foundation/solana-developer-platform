/**
 * Regression: issuance creation must admit audit before committing state and
 * must replay an identical Idempotency-Key retry instead of duplicating.
 *
 * Reported as SOLA9-195 (APE-719): POST /v1/issuance/tokens committed the
 * issued_tokens + asset_profiles pair BEFORE audit admission. A stale
 * external audit checkpoint (a controlled audit-ledger outage, read from
 * Redis by the real AuditService) made the route return 500 AFTER PostgreSQL
 * committed, and a retry with the same Idempotency-Key created a second
 * unaudited draft pair.
 *
 * Secure invariants asserted here:
 *  1. During an audit outage the route must not leave committed issuance
 *     state behind (audit admission is fail-closed BEFORE the effect).
 *  2. Once the audit ledger recovers, the identical request + key succeeds
 *     exactly once: one token, one profile, one create audit event.
 *  3. A retry of a successful creation with the same key + payload replays
 *     the original token instead of creating a second one.
 *  4. The same key with a different payload is a 409 conflict.
 *  5. Requests without an Idempotency-Key keep creating independent drafts.
 * Both POST /v1/issuance/tokens and POST /v1/issuance/asset-profiles are
 * covered.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { AUDIT_LEDGER_CHECKPOINT_KEY } from "@/services/audit.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedCachedApiKey } from "@/test/mocks/kv";

const TOKEN_BODY = { name: "Admission Draft", symbol: "ADM", decimals: 6 };
const PROFILE_BODY = {
  ...TOKEN_BODY,
  assetCategory: "generic",
  assetType: "generic",
};

async function countRows(query: string, ...bind: string[]): Promise<number> {
  const statement = getDb(env).prepare(query);
  const result = await (bind.length > 0 ? statement.bind(...bind) : statement).first<{
    count: number;
  }>();
  return Number(result?.count ?? 0);
}

const tokenCount = (name: string) =>
  countRows("SELECT COUNT(*)::int AS count FROM issued_tokens WHERE name = ?", name);
const profileCount = (name: string) =>
  countRows(
    "SELECT COUNT(*)::int AS count FROM asset_profiles WHERE token_id IN (SELECT id FROM issued_tokens WHERE name = ?)",
    name
  );
// Per-token: audit_logs is append-only (no cross-test cleanup), so the count
// is scoped to the token id created by the case under test.
const createAuditCount = (tokenId: string) =>
  countRows(
    "SELECT COUNT(*)::int AS count FROM audit_logs WHERE resource_type = 'token' AND action = 'create' AND status = 'success' AND resource_id = ?",
    tokenId
  );

describe("issuance creation: audit admission before effect + idempotent replay", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
    });

    apiKeyHash = await seedProjectApiKey(db, env, {
      key: TEST_PROJECT_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["tokens:write"],
    });
    await seedCachedApiKey(env, apiKeyHash, {
      ...TEST_PROJECT_CACHED_KEY,
      permissions: ["tokens:write"],
    });
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    const keys = await kv.rateLimits.list();
    for (const key of keys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db
      .prepare(
        "DELETE FROM asset_profiles WHERE token_id IN (SELECT id FROM issued_tokens WHERE name = ?)"
      )
      .bind(TOKEN_BODY.name)
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issued_tokens WHERE name = ?")
      .bind(TOKEN_BODY.name)
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM issuance_create_idempotency")
      .run()
      .catch(() => {});
    await kv.cache.delete(AUDIT_LEDGER_CHECKPOINT_KEY);
  });

  const headers = (idempotencyKey?: string) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
    ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
  });

  describe("POST /v1/issuance/tokens", () => {
    it("commits nothing while the audit ledger is down and creates exactly one draft once it recovers", async () => {
      const cache = createKVStoreSet(env).cache;
      // Controlled audit-ledger outage: an invalid external checkpoint makes
      // the real AuditService fail closed. This is not a route mock.
      await cache.put(AUDIT_LEDGER_CHECKPOINT_KEY, "stale-checkpoint");

      const rejected = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: headers("admission-recovery"),
          body: JSON.stringify(TOKEN_BODY),
        },
        env
      );
      expect(rejected.status).toBe(500);
      // The fix: no issuance state may outlive a failed audit admission.
      expect(await tokenCount(TOKEN_BODY.name)).toBe(0);
      expect(await profileCount(TOKEN_BODY.name)).toBe(0);

      // The outage clears; the identical request + key is the FIRST admission.
      await cache.delete(AUDIT_LEDGER_CHECKPOINT_KEY);
      const recovered = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: headers("admission-recovery"),
          body: JSON.stringify(TOKEN_BODY),
        },
        env
      );
      expect(recovered.status).toBe(201);
      const recoveredBody = await recovered.json();
      expect(recoveredBody.data.token.id).toMatch(/^tok_/);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
      expect(await profileCount(TOKEN_BODY.name)).toBe(1);
      expect(await createAuditCount(recoveredBody.data.token.id)).toBe(1);
    });

    it("replays the original token for an identical retry instead of duplicating it", async () => {
      const first = await app.request(
        "/v1/issuance/tokens",
        { method: "POST", headers: headers("replay-same-body"), body: JSON.stringify(TOKEN_BODY) },
        env
      );
      expect(first.status).toBe(201);
      const firstBody = await first.json();

      const retry = await app.request(
        "/v1/issuance/tokens",
        { method: "POST", headers: headers("replay-same-body"), body: JSON.stringify(TOKEN_BODY) },
        env
      );
      expect(retry.status).toBe(201);
      const retryBody = await retry.json();
      expect(retryBody.data.token.id).toBe(firstBody.data.token.id);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
      expect(await profileCount(TOKEN_BODY.name)).toBe(1);
      expect(await createAuditCount(firstBody.data.token.id)).toBe(1);
    });

    it("rejects a reused key with a different payload", async () => {
      const first = await app.request(
        "/v1/issuance/tokens",
        { method: "POST", headers: headers("conflict-payload"), body: JSON.stringify(TOKEN_BODY) },
        env
      );
      expect(first.status).toBe(201);

      const mismatch = await app.request(
        "/v1/issuance/tokens",
        {
          method: "POST",
          headers: headers("conflict-payload"),
          body: JSON.stringify({ ...TOKEN_BODY, name: "Different Draft" }),
        },
        env
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toMatchObject({ error: { code: "CONFLICT" } });
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
      expect(await tokenCount("Different Draft")).toBe(0);
    });

    it("keeps keyless requests independent", async () => {
      const first = await app.request(
        "/v1/issuance/tokens",
        { method: "POST", headers: headers(), body: JSON.stringify(TOKEN_BODY) },
        env
      );
      const second = await app.request(
        "/v1/issuance/tokens",
        { method: "POST", headers: headers(), body: JSON.stringify(TOKEN_BODY) },
        env
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(firstBody.data.token.id).not.toBe(secondBody.data.token.id);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(2);
    });
  });

  describe("POST /v1/issuance/asset-profiles", () => {
    it("commits nothing while the audit ledger is down and creates exactly one pair once it recovers", async () => {
      const cache = createKVStoreSet(env).cache;
      await cache.put(AUDIT_LEDGER_CHECKPOINT_KEY, "stale-checkpoint");

      const rejected = await app.request(
        "/v1/issuance/asset-profiles",
        {
          method: "POST",
          headers: headers("profile-recovery"),
          body: JSON.stringify(PROFILE_BODY),
        },
        env
      );
      expect(rejected.status).toBe(500);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(0);
      expect(await profileCount(TOKEN_BODY.name)).toBe(0);

      await cache.delete(AUDIT_LEDGER_CHECKPOINT_KEY);
      const recovered = await app.request(
        "/v1/issuance/asset-profiles",
        {
          method: "POST",
          headers: headers("profile-recovery"),
          body: JSON.stringify(PROFILE_BODY),
        },
        env
      );
      expect(recovered.status).toBe(201);
      const recoveredBody = await recovered.json();
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
      expect(await profileCount(TOKEN_BODY.name)).toBe(1);
      expect(await createAuditCount(recoveredBody.data.token.id)).toBe(1);
    });

    it("replays the original pair for an identical retry and conflicts on a different payload", async () => {
      const first = await app.request(
        "/v1/issuance/asset-profiles",
        { method: "POST", headers: headers("profile-replay"), body: JSON.stringify(PROFILE_BODY) },
        env
      );
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.data.assetProfile).toBeDefined();

      const retry = await app.request(
        "/v1/issuance/asset-profiles",
        { method: "POST", headers: headers("profile-replay"), body: JSON.stringify(PROFILE_BODY) },
        env
      );
      expect(retry.status).toBe(201);
      const retryBody = await retry.json();
      expect(retryBody.data.token.id).toBe(firstBody.data.token.id);
      expect(retryBody.data.assetProfile.id).toBe(firstBody.data.assetProfile.id);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
      expect(await profileCount(TOKEN_BODY.name)).toBe(1);

      const mismatch = await app.request(
        "/v1/issuance/asset-profiles",
        {
          method: "POST",
          headers: headers("profile-replay"),
          body: JSON.stringify({ ...PROFILE_BODY, decimals: 9 }),
        },
        env
      );
      expect(mismatch.status).toBe(409);
      expect(await tokenCount(TOKEN_BODY.name)).toBe(1);
    });
  });
});
