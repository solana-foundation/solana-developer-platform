import { hashString } from "@sdp/payments/hash";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { ISSUANCE_PREPARE_QUOTA, ISSUANCE_SUPPLY_QUOTA } from "@/routes/issuance";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_ACTIVE_TOKEN,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  clearKVStores,
  readRateLimitCount,
  seedCachedApiKey,
  seedRateLimit,
} from "@/test/mocks/kv";

const SUPPLY_ACTOR_COUNTER = `metered:${ISSUANCE_SUPPLY_QUOTA.name}:org:${TEST_ORG.id}:key:${TEST_PROJECT_API_KEY.id}`;
const PREPARE_ACTOR_COUNTER = `metered:${ISSUANCE_PREPARE_QUOTA.name}:org:${TEST_ORG.id}:key:${TEST_PROJECT_API_KEY.id}`;

describe("Issuance routes — metered quota", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await clearKVStores(env);
    const keyHash = await hashString(TEST_PROJECT_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, TEST_PROJECT_CACHED_KEY);

    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Quota Project', ?, 'sandbox', 'active', ?) ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id)
      .run();
  });

  it("does not charge quota counters for callers the permission gate rejects", async () => {
    const keyHash = await hashString("sk_test_quota_readonly", env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_PROJECT_CACHED_KEY,
      id: "key_quota_readonly",
      role: "api_readonly",
      permissions: ["payments:read"],
    });

    const res = await app.request(
      `/v1/issuance/tokens/${TEST_ACTIVE_TOKEN.id}/supply/refresh`,
      {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_quota_readonly" },
      },
      env
    );

    expect(res.status).toBe(403);
    expect(
      await readRateLimitCount(
        env,
        `metered:issuance-supply:org:${TEST_ORG.id}:key:key_quota_readonly`
      )
    ).toBe(0);
  });

  it("429s a supply refresh once the actor quota is exhausted", async () => {
    await seedRateLimit(env, SUPPLY_ACTOR_COUNTER, ISSUANCE_SUPPLY_QUOTA.actorMax);

    const res = await app.request(
      `/v1/issuance/tokens/${TEST_ACTIVE_TOKEN.id}/supply/refresh`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}` },
      },
      env
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("429s a mint prepare once the actor quota is exhausted", async () => {
    await seedRateLimit(env, PREPARE_ACTOR_COUNTER, ISSUANCE_PREPARE_QUOTA.actorMax);

    const res = await app.request(
      `/v1/issuance/tokens/${TEST_ACTIVE_TOKEN.id}/mint/prepare`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({ mint: { destination: TEST_ACTIVE_TOKEN.mintAddress, amount: "1" } }),
      },
      env
    );

    expect(res.status).toBe(429);
  });
});
