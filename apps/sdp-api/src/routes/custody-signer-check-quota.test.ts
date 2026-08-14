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

const TEST_ORG_ID = "org_signer_check_quota";
const TEST_API_KEY = {
  id: "key_signer_check_quota",
  raw: "sk_test_signer_check_quota_fixture",
};

const ACTOR_COUNTER = `metered:signer-check:org:${TEST_ORG_ID}:key:${TEST_API_KEY.id}`;
const ORG_COUNTER = `metered:signer-check:org:${TEST_ORG_ID}`;
const ATTEMPT_ACTOR_COUNTER = `metered:signer-check-attempt:org:${TEST_ORG_ID}:key:${TEST_API_KEY.id}`;
const ATTEMPT_ORG_COUNTER = `metered:signer-check-attempt:org:${TEST_ORG_ID}`;

function cachedKey(permissions: CachedApiKey["permissions"]): CachedApiKey {
  return {
    id: TEST_API_KEY.id,
    organizationId: TEST_ORG_ID,
    projectId: "prj_signer_check_quota",
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

async function requestSignerCheck(): Promise<Response> {
  return await app.request(
    "/v1/wallets/signer-check",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify({}),
    },
    env
  );
}

describe("Signer check route — metered quota", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("does not charge quota counters for callers the permission gate rejects", async () => {
    await seedKey(["wallets:read"]);

    const res = await requestSignerCheck();

    expect(res.status).toBe(403);
    expect(await readRateLimitCount(env, ACTOR_COUNTER)).toBe(0);
    expect(await readRateLimitCount(env, ORG_COUNTER)).toBe(0);
  });

  // A caller that clears the permission gate but never reaches the fee-paying
  // handler (here an unbound signing wallet, the same shape as a policy
  // denial) must not spend the shared quota, or one misconfigured key could
  // lock every other key in the org out of signer checks.
  it("does not charge quota counters when the request never reaches the handler", async () => {
    await seedKey(["wallets:write"]);

    const res = await requestSignerCheck();

    expect(res.status).toBe(400);
    expect(await readRateLimitCount(env, ACTOR_COUNTER)).toBe(0);
    expect(await readRateLimitCount(env, ORG_COUNTER)).toBe(0);
  });

  it("does not 429 a request that stops before the fee-paying handler", async () => {
    await seedKey(["wallets:write"]);
    await seedRateLimit(env, ACTOR_COUNTER, 10);
    await seedRateLimit(env, ORG_COUNTER, 30);

    const res = await requestSignerCheck();

    // An exhausted fee ceiling no longer rejects a call that was never going
    // to broadcast; that ceiling applies at the handler, where fees are spent.
    expect(res.status).toBe(400);
  });

  it("429s once the attempt ceiling is exhausted, before any policy work", async () => {
    await seedKey(["wallets:write"]);
    await seedRateLimit(env, ATTEMPT_ACTOR_COUNTER, 30);

    const res = await requestSignerCheck();

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("429s once the org-wide attempt ceiling is exhausted", async () => {
    await seedKey(["wallets:write"]);
    await seedRateLimit(env, ATTEMPT_ORG_COUNTER, 90);

    const res = await requestSignerCheck();

    expect(res.status).toBe(429);
  });
});
