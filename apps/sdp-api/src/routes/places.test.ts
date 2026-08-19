import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  clearKVStores,
  readRateLimitCount,
  seedCachedApiKey,
  seedRateLimit,
} from "@/test/mocks/kv";

const TEST_ORG_ID = "org_places_test";
const TEST_API_KEY = {
  id: "key_places_test",
  raw: "sk_test_places_fixture",
};

const ACTOR_COUNTER = `metered:places:org:${TEST_ORG_ID}:key:${TEST_API_KEY.id}`;
const ORG_COUNTER = `metered:places:org:${TEST_ORG_ID}`;

function cachedKey(permissions: CachedApiKey["permissions"]): CachedApiKey {
  return {
    id: TEST_API_KEY.id,
    organizationId: TEST_ORG_ID,
    projectId: "prj_places_test",
    role: "api_developer",
    permissions,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function seedKey(permissions: CachedApiKey["permissions"]): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey(permissions));
}

async function requestAutocomplete(): Promise<Response> {
  return await app.request(
    "/v1/places/autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify({ input: "1 Main St", sessionToken: "test-session-token" }),
    },
    env
  );
}

describe("Places routes — metered quota", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("does not charge quota counters for callers the permission gate rejects", async () => {
    await seedKey(["payments:read"]);

    const res = await requestAutocomplete();

    expect(res.status).toBe(403);
    expect(await readRateLimitCount(env, ACTOR_COUNTER)).toBe(0);
    expect(await readRateLimitCount(env, ORG_COUNTER)).toBe(0);
  });

  it("429s an authorized caller once the actor quota is exhausted", async () => {
    await seedKey(["counterparties:write"]);
    await seedRateLimit(env, ACTOR_COUNTER, 120);

    const res = await requestAutocomplete();

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("429s an authorized caller once the org-wide quota is exhausted", async () => {
    await seedKey(["counterparties:write"]);
    await seedRateLimit(env, ORG_COUNTER, 600);

    const res = await requestAutocomplete();

    expect(res.status).toBe(429);
  });
});
