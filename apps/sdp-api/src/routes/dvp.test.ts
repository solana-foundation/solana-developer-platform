import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = { id: "org_dvp_test", name: "DvP Test Org", slug: "dvp-test-org" };
const TEST_PROJECT = { id: "prj_dvp_test", slug: "dvp-test-project" };
const TEST_USER = { id: "usr_dvp_test", email: "dvp-test@example.com" };
const TEST_API_KEY = { id: "key_dvp_test", raw: "sk_test_dvp_routes", prefix: "sk_test_dvp" };

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalMarkets: string | undefined;
let originalDvp: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "DvP Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

/** A well-formed create body. Amounts are strings on purpose; see schemas.ts. */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    sdpWalletId: "cwlt_dvp_test",
    sdpSide: "a",
    counterparty: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  };
}

describe("DvP routes", () => {
  beforeEach(async () => {
    originalMarkets = env.MARKETS_ENABLED;
    originalDvp = env.DVP_ENABLED;
    env.MARKETS_ENABLED = "true";
    env.DVP_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.MARKETS_ENABLED = originalMarkets;
    env.DVP_ENABLED = originalDvp;
    await clearKVStores(env);
  });

  it("returns 403 when the DvP flag is off", async () => {
    env.DVP_ENABLED = undefined;
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  // DvP is a Markets sub-module, so clearing the parent has to dark-launch it
  // even with its own flag on. Same hierarchy Earn uses.
  it("returns 403 when Markets is off even though DvP is on", async () => {
    env.MARKETS_ENABLED = undefined;
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await app.request("/v1/dvp/trades", {}, env);
    expect(res.status).toBe(401);
  });

  it("lists no trades for a fresh project", async () => {
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ trades: [] });
  });

  it("404s an unknown trade", async () => {
    const res = await app.request("/v1/dvp/trades/dvp_missing", { headers: authHeaders() }, env);
    expect(res.status).toBe(404);
  });

  // The schema takes u64s as strings. A JSON number rounds above 2^53, and for
  // the nonce that would publish an escrow address that does not match the
  // trade, so the surface refuses numbers outright rather than coercing them.
  it("rejects a numeric amount rather than coercing it", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ amountA: 1000 })),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-base58 counterparty", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ counterparty: "not-an-address" })),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects a ref string longer than the program's 64-byte field", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ refString: "x".repeat(65) })),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});
