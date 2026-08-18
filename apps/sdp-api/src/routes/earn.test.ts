import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnProviderWalletRow,
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
    hostCluster: "devnet",
    environment: "sandbox",
    ...overrides,
  });
  if (!strategy) {
    throw new Error("Failed to seed earn strategy");
  }
  return strategy;
}

/**
 * A real `earn_provider_wallets` row, so the `:programId` probes below ride an
 * id the handler actually resolves. Provider "ground" on purpose: it is NOT the
 * entitled provider here (seedAuth entitles only "veda") and this file sets no
 * GROUND credentials, which is exactly why the probe uses the one per-program
 * route that takes no provider gate at all.
 */
async function seedProgram(): Promise<EarnProviderWalletRow> {
  const row = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "ground",
    providerWalletRef: crypto.randomUUID(),
    label: null,
    createdBy: TEST_USER.id,
  });
  if (!row) {
    throw new Error("Failed to seed earn program");
  }
  return row;
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

describe("Earn routes — retired program surfaces (PRO-1670)", () => {
  // The singular `/program` family was an implicit create-or-update keyed on
  // (organization, environment, provider), which stops being addressable the
  // moment a second program exists. Every path below has an addressable
  // `/programs[/:programId]` replacement; a stale registration would quietly
  // hand callers the one-program model back.
  //
  // Both tests PAIR the 404s with a live probe of the replacement, because a 404
  // for a URL that was never registered passes even if the replacement is
  // broken — the same trap the /nav case above avoids by riding a real strategy
  // id. This file's seedAuth entitles only "veda" and sets no GROUND
  // credentials, so the probes are deliberately the two program routes that
  // answer without any provider call: the UNFILTERED collection (no provider
  // named ⇒ no credential gate) and the withdrawal LEDGER list (no provider gate
  // whatsoever, by design — ADR 0002: the audit trail outlives credential
  // removal).

  it("serves 404 for the singular /program paths, while the collection answers", async () => {
    await seedAuth();

    for (const path of [
      "/v1/earn/program",
      "/v1/earn/program?provider=ground",
      "/v1/earn/program/deposits",
      "/v1/earn/program/withdrawals",
      "/v1/earn/program/withdrawals/wd_x",
    ]) {
      const res = await getEarn(path);
      expect(res.status, path).toBe(404);
    }

    for (const [method, path] of [
      ["PUT", "/v1/earn/program"],
      ["POST", "/v1/earn/program/withdrawals"],
      ["POST", "/v1/earn/program/withdrawal-preview"],
    ] as const) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({}),
        },
        env
      );
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // The pairing: /programs is registered and serves the collection envelope
    // end to end. An empty collection is a 200, never a 404 — the plural surface
    // cannot 404 for emptiness, which is what makes the 404s above meaningful.
    const collection = await getEarn("/v1/earn/programs");
    expect(collection.status).toBe(200);
    const body = (await collection.json()) as {
      data: { programs: unknown[]; total: number; page: number; pageSize: number };
    };
    expect(body.data).toEqual({ programs: [], total: 0, page: 1, pageSize: 20 });
  });

  it("routes the per-program sub-paths under a real program id", async () => {
    await seedAuth();
    const program = await seedProgram();

    // The retired sub-paths 404 …
    for (const path of ["/v1/earn/program/deposits", "/v1/earn/program/withdrawals"]) {
      const res = await getEarn(path);
      expect(res.status, path).toBe(404);
    }

    // … and the same shape under `/programs/:programId` resolves the row and
    // answers. Non-vacuous by construction: swap in an id that does not exist
    // and this is a 404 too, so the 200 proves the route is registered AND that
    // the id addressed a real program.
    const ledger = await getEarn(`/v1/earn/programs/${program.id}/withdrawals`);
    expect(ledger.status).toBe(200);
    const ledgerBody = (await ledger.json()) as {
      data: { withdrawals: unknown[]; total: number };
    };
    expect(ledgerBody.data.withdrawals).toEqual([]);
    expect(ledgerBody.data.total).toBe(0);

    const unknownProgram = await getEarn("/v1/earn/programs/earn_provider_wallet_nope/withdrawals");
    expect(unknownProgram.status).toBe(404);
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

  /**
   * `fundable` is derived per request, so the SAME row answers differently to a
   * sandbox and a production caller. This is the wire-level warning a partner
   * reads before treating a listed strategy as depositable — a mainnet-only
   * provider's vaults are listed in sandbox on purpose and must never look
   * fundable there.
   */
  it("derives fundable from hostCluster against the caller's environment", async () => {
    await seedAuth();
    const local = await seedStrategy({ hostCluster: "devnet" });
    const elsewhere = await seedStrategy({ hostCluster: "mainnet-beta" });

    const res = await getEarn("/v1/earn/strategies");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        strategies: Array<{ id: string; hostCluster: string; fundable: boolean }>;
      };
    };
    const byId = new Map(body.data.strategies.map((s) => [s.id, s]));
    expect(byId.get(local.id)).toMatchObject({ hostCluster: "devnet", fundable: true });
    // Listed, and explicitly not fundable — the row is honest about both.
    expect(byId.get(elsewhere.id)).toMatchObject({
      hostCluster: "mainnet-beta",
      fundable: false,
    });
  });

  it("carries hostCluster and fundable on the single-strategy read too", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });

    const res = await getEarn(`/v1/earn/strategies/${strategy.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { strategy: { hostCluster: string; fundable: boolean } };
    };
    expect(body.data.strategy).toMatchObject({ hostCluster: "mainnet-beta", fundable: false });
  });

  /**
   * Browse policy, which is a DIFFERENT question from `fundable` above and must
   * not be collapsed into it: a hidden row is absent from the response entirely,
   * while an un-fundable row is present and says so. Hiding is SDP's editorial
   * choice about a source; `fundable` is a fact about where the instrument
   * lives.
   */
  it("stores Morpho and Aave rows but never returns them from strategy reads", async () => {
    await seedAuth();
    const visible = await seedStrategy({
      provider: "ground",
      providerReference: "kamino-steakhouse-usdc",
      name: "Kamino Steakhouse USDC",
      underlyingSource: "kamino",
    });
    const morpho = await seedStrategy({
      provider: "ground",
      providerReference: "morpho-gauntlet-usdc",
      name: "Gauntlet USDC Prime",
      underlyingSource: "morpho",
    });
    const aave = await seedStrategy({
      provider: "ground",
      providerReference: "aave-v3-usdc",
      name: "Aave V3 Core USDC",
      // Pin the fallback matching path too: a related row remains hidden even
      // if provider metadata arrives without an underlying-source value.
      underlyingSource: null,
    });

    const repository = createPostgresEarnRepository(getDb(env));
    expect(await repository.getStrategyById(morpho.id)).not.toBeNull();
    expect(await repository.getStrategyById(aave.id)).not.toBeNull();

    const list = await getEarn("/v1/earn/strategies?pageSize=1");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number; pageSize: number };
    };
    expect(listBody.data.strategies.map((strategy) => strategy.id)).toEqual([visible.id]);
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.pageSize).toBe(1);

    for (const hidden of [morpho, aave]) {
      const detail = await getEarn(`/v1/earn/strategies/${hidden.id}`);
      expect(detail.status).toBe(404);
    }
  });
});
