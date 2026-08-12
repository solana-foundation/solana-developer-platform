import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_earn_routes",
  name: "Earn Routes Org",
  slug: "earn-routes",
};
const TEST_PROJECT = {
  id: "prj_test_earn_routes",
  slug: "test-earn-routes-project",
};
const TEST_USER = {
  id: "usr_earn_routes",
  email: "earn-routes@example.com",
};
const TEST_API_KEY = {
  id: "key_earn_routes",
  raw: "sk_test_earn_routes",
  prefix: "sk_test_ear",
};
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
const TEST_PRODUCTION_PROJECT = {
  id: "prj_test_earn_routes_prod",
  slug: "test-earn-routes-project-prod",
};
const TEST_SESSION_ID = "ses_earn_routes";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        TEST_ORG.id,
        TEST_ORG.name,
        TEST_ORG.slug,
        "enterprise",
        "active",
        JSON.stringify({ providerOverrides: { earn: { veda: true } } })
      ),
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
        "Earn Routes Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

/**
 * Dashboard (session) callers resolve their environment from the membership-
 * verified x-project-id project, so the session fixture carries both the
 * sandbox project seedAuth created and a production sibling. Call after
 * seedAuth().
 */
async function seedSessionAuth(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'member', 'active')`
      )
      .bind("om_earn_routes_session", TEST_ORG.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'production', 'active', ?)`
      )
      .bind(
        TEST_PRODUCTION_PROJECT.id,
        TEST_ORG.id,
        "Production Project",
        TEST_PRODUCTION_PROJECT.slug,
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_earn_routes_sandbox", TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_earn_routes_production", TEST_PRODUCTION_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(TEST_SESSION_ID, TEST_USER.id, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
  ]);
}

async function seedStrategy(
  overrides: Partial<UpsertEarnStrategyInput> = {}
): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "veda",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Test USDC Vault",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [USDC_MINT],
    shareMint: null,
    apyType: "variable",
    currentApy: "0.062",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    environment: "sandbox",
    ...overrides,
  });
  if (!strategy) {
    throw new Error("Failed to seed earn strategy");
  }
  return strategy;
}

function getEarn(path: string) {
  return app.request(
    path,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
    },
    env
  );
}

function getEarnAsSession(path: string, projectId: string) {
  return app.request(
    path,
    {
      method: "GET",
      headers: { Cookie: `sdp_session=${TEST_SESSION_ID}`, "x-project-id": projectId },
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  // Earn is a Markets sub-module, so both gates have to be on to reach a route.
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  await clearKVStores(env);
});

describe("Earn routes — feature flag gate", () => {
  it("returns 403 for /v1/earn routes while EARN_ENABLED is unset", async () => {
    env.EARN_ENABLED = undefined;
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Earn is not enabled");
  });

  it("returns 403 while MARKETS_ENABLED is off even though EARN_ENABLED is on", async () => {
    // Regression: the parent Markets gate must kill the sub-module's routes.
    env.MARKETS_ENABLED = undefined;
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Earn is not enabled");
  });

  it("serves the same route once EARN_ENABLED is true", async () => {
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies");

    expect(res.status).toBe(200);
  });
});

describe("Earn routes — retired surfaces stay retired (PRO-1628)", () => {
  it("serves 404 for the removed positions/movements/quotes/nav routes", async () => {
    // The empty-ledger and permanently-501 surfaces were removed by the
    // ledger-vs-live decision (ADR 0002 addendum). If any of these come back,
    // it must be a deliberate re-introduction, not a leftover registration.
    await seedAuth();
    // The NAV probe rides a REAL strategy id: a resurrected /nav route would
    // 200 here, whereas a made-up id would 404 either way (vacuous).
    const strategy = await seedStrategy();

    for (const path of [
      "/v1/earn/positions",
      "/v1/earn/positions/pos_1",
      "/v1/earn/movements",
      "/v1/earn/movements/mov_1",
      `/v1/earn/strategies/${strategy.id}/nav`,
    ]) {
      const res = await getEarn(path);
      expect(res.status, path).toBe(404);
    }

    for (const path of ["/v1/earn/deposits/quote", "/v1/earn/withdrawals/quote"]) {
      const res = await app.request(
        path,
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
      expect(res.status, path).toBe(404);
    }
  });
});

describe("Earn routes — environment scoping", () => {
  it("hides production strategies from a sandbox API key", async () => {
    await seedAuth();
    const sandbox = await seedStrategy();
    const production = await seedStrategy({ environment: "production" });

    const visible = await getEarn(`/v1/earn/strategies/${sandbox.id}`);
    expect(visible.status).toBe(200);

    const hidden = await getEarn(`/v1/earn/strategies/${production.id}`);
    expect(hidden.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    expect(hiddenBody.error.code).toBe("NOT_FOUND");

    const list = await getEarn("/v1/earn/strategies");
    const listBody = (await list.json()) as { data: { strategies: Array<{ id: string }> } };
    expect(listBody.data.strategies.map((s) => s.id)).toEqual([sandbox.id]);
  });
});

describe("Earn routes — session-caller environment resolution", () => {
  it("scopes the catalogue to the session's selected project environment", async () => {
    await seedAuth();
    await seedSessionAuth();
    const sandbox = await seedStrategy();
    const production = await seedStrategy({ environment: "production" });

    // A production-project session sees the production catalogue…
    const productionList = await getEarnAsSession(
      "/v1/earn/strategies",
      TEST_PRODUCTION_PROJECT.id
    );
    expect(productionList.status).toBe(200);
    const productionBody = (await productionList.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(productionBody.data.strategies.map((s) => s.id)).toEqual([production.id]);

    const hidden = await getEarnAsSession(
      `/v1/earn/strategies/${sandbox.id}`,
      TEST_PRODUCTION_PROJECT.id
    );
    expect(hidden.status).toBe(404);

    // …and a sandbox-project session keeps today's behavior exactly.
    const sandboxList = await getEarnAsSession("/v1/earn/strategies", TEST_PROJECT.id);
    expect(sandboxList.status).toBe(200);
    const sandboxBody = (await sandboxList.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(sandboxBody.data.strategies.map((s) => s.id)).toEqual([sandbox.id]);
  });
});

describe("Earn routes — strategy catalogue", () => {
  it("returns the paginated list envelope and omits non-active strategies", async () => {
    await seedAuth();
    const active = await seedStrategy();
    await seedStrategy({ status: "paused" });

    const res = await getEarn("/v1/earn/strategies");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        strategies: Array<{ id: string; provider: string; status: string }>;
        total: number;
        page: number;
        pageSize: number;
      };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([active.id]);
    expect(body.data.total).toBe(1);
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(20);
  });
});
