import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Most tests here bypass the per-vault CURATED_VAULTS allowlists: the shipped
 * shelf changes with BD decisions, and the seeds use random references that no
 * real allowlist could carry — the same reason earn-program.test.ts bypasses
 * `isEarnProviderSurfaced`. The real config gets its own describe below
 * ("shipped V1 curation"), which flips this off and runs against the real
 * lists. HIDDEN_STRATEGY_TERMS stays real everywhere: seeds control their own
 * names.
 */
const curation = vi.hoisted(() => ({ bypassCuratedVaults: true }));

vi.mock("@/routes/earn/handlers/curation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/routes/earn/handlers/curation")>();
  return {
    ...actual,
    get CURATED_VAULTS() {
      return curation.bypassCuratedVaults ? {} : actual.CURATED_VAULTS;
    },
  };
});

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
    // A SURFACED provider (EARN_PROVIDER_SURFACING in @sdp/types). Catalogue
    // reads hide un-surfaced providers wholesale, so seeding one here would make
    // every test in this file assert 404s for a reason it never meant to test.
    // The provider-visibility rule gets its own test below.
    provider: "kamino",
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
  curation.bypassCuratedVaults = true;
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
      // `/v1/earn/movements` is NOT in this list any more — see the deliberate
      // re-introduction below. The ITEM route still is: PRO-1705 brought back the
      // collection alone, and a movement is read by its family's detail route.
      "/v1/earn/movements/mov_1",
      `/v1/earn/strategies/${strategy.id}/nav`,
      // The UI builder's persistence routes left with the builder itself; the
      // integration guide is derived from the catalogue and stores nothing.
      "/v1/earn/button-configurations/current",
      "/v1/earn/button-configurations/public/AbCdEfGhIjKlMnOpQrStUvWx",
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

  it("serves the DELIBERATELY re-introduced movements collection (PRO-1705)", async () => {
    // This is the re-introduction the test above demands be deliberate. PRO-1628
    // pruned `/v1/earn/movements` together with 0048's never-written table, and
    // PRO-1669 was explicit that the NAME was free while the SHAPE was not: the
    // old route was a position-scoped read over base-unit amounts. What answers
    // here is the unified ledger's cross-provider feed — a different contract that
    // happens to reclaim the path.
    //
    // Paired with a real response rather than just a non-404, for the same reason
    // the /nav probe rides a real strategy id: asserting the absence of a 404
    // would pass on a route that is registered but broken.
    await seedAuth();

    const res = await getEarn("/v1/earn/movements");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { movements: unknown[]; hasMore: boolean; nextCursor: string | null };
    };
    expect(body.data).toEqual({ movements: [], hasMore: false, nextCursor: null });
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
    // On its own cluster, so the production default view (which lists the
    // environment's own cluster since PRO-1742) includes it.
    const production = await seedStrategy({
      environment: "production",
      hostCluster: "mainnet-beta",
    });

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

// The Earn button-configuration routes (`/button-configurations/*`) were
// removed with the UI builder; their 404 pins live in the retired-surfaces
// describe above alongside the PRO-1628 removals.

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
   * sandbox and a production caller — the wire-level warning a partner reads
   * before treating a listed strategy as depositable. Since PRO-1742 a sandbox
   * environment deliberately stores the mirrored mainnet shelf BESIDE its own,
   * so the list defaults to the environment's own cluster: an integrator's
   * default view stays a catalogue it can act on, and the mirrored rows are an
   * explicit `?cluster=` opt-in whose rows arrive `fundable: false`.
   */
  it("lists the environment's own cluster by default and the mirrored shelf on explicit opt-in", async () => {
    await seedAuth();
    const local = await seedStrategy({ hostCluster: "devnet" });
    const mirrored = await seedStrategy({ hostCluster: "mainnet-beta" });

    const defaults = await getEarn("/v1/earn/strategies");
    expect(defaults.status).toBe(200);
    const defaultBody = (await defaults.json()) as {
      data: {
        strategies: Array<{ id: string; hostCluster: string; fundable: boolean }>;
        total: number;
      };
    };
    expect(defaultBody.data.strategies.map((s) => s.id)).toEqual([local.id]);
    expect(defaultBody.data.strategies[0]).toMatchObject({
      hostCluster: "devnet",
      fundable: true,
    });
    // The filter runs in SQL: the total describes the default view, not the
    // store, so pagination never walks a reader into hidden rows.
    expect(defaultBody.data.total).toBe(1);

    const optIn = await getEarn("/v1/earn/strategies?cluster=mainnet-beta");
    expect(optIn.status).toBe(200);
    const optInBody = (await optIn.json()) as {
      data: {
        strategies: Array<{ id: string; hostCluster: string; fundable: boolean }>;
        total: number;
      };
    };
    expect(optInBody.data.strategies.map((s) => s.id)).toEqual([mirrored.id]);
    // Listed, and explicitly not fundable — the row is honest about both.
    expect(optInBody.data.strategies[0]).toMatchObject({
      hostCluster: "mainnet-beta",
      fundable: false,
    });
    expect(optInBody.data.total).toBe(1);
  });

  it("rejects a cluster value outside the Solana cluster vocabulary", async () => {
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies?cluster=testnet");

    expect(res.status).toBe(400);
  });

  it("carries hostCluster and fundable on the single-strategy read too", async () => {
    // Deliberate asymmetry with the list default above: an explicitly
    // addressed row is served whatever its cluster — honest, never hidden.
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
      providerReference: "kamino-steakhouse-usdc",
      name: "Kamino Steakhouse USDC",
      underlyingSource: "kamino",
    });
    const morpho = await seedStrategy({
      providerReference: "morpho-gauntlet-usdc",
      name: "Gauntlet USDC Prime",
      underlyingSource: "morpho",
    });
    const aave = await seedStrategy({
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

  /**
   * The OTHER visibility rule, and the one that scales: a provider SDP does not
   * currently offer (`EARN_PROVIDER_SURFACING` in @sdp/types) contributes no
   * rows at all, whatever they are named.
   *
   * Asserted against the stored row so the two halves stay honest: the sync
   * keeps writing an un-surfaced provider's catalogue — which is what makes
   * re-surfacing a deploy rather than an hour's wait — and only the read hides
   * it. Ground is the un-surfaced provider today; if that flips, this test
   * should move to whichever provider is off rather than be deleted.
   */
  it("stores an un-surfaced provider's rows but never returns them from strategy reads", async () => {
    await seedAuth();
    const surfaced = await seedStrategy({ providerReference: "kamino-visible-usdc" });
    const unsurfaced = await seedStrategy({
      provider: "ground",
      providerReference: "ground-hidden-usdc",
      name: "Ground Institutional USDC",
      underlyingSource: "centrifuge",
    });

    // Still stored — hiding is a read-time policy, never a refusal to persist.
    const repository = createPostgresEarnRepository(getDb(env));
    expect(await repository.getStrategyById(unsurfaced.id)).not.toBeNull();

    const list = await getEarn("/v1/earn/strategies");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(listBody.data.strategies.map((strategy) => strategy.id)).toEqual([surfaced.id]);
    // The filter runs in SQL, so the total describes the rows the caller can
    // see rather than counting a row the page then drops.
    expect(listBody.data.total).toBe(1);

    const detail = await getEarn(`/v1/earn/strategies/${unsurfaced.id}`);
    expect(detail.status).toBe(404);
  });
});

/**
 * The REAL shipped curation (PRO-1727) — the one describe that runs against the
 * actual CURATED_VAULTS/HIDDEN_STRATEGY_TERMS config rather than the bypass.
 * Addresses are read from the config itself so a BD re-pick moves these tests
 * with it instead of breaking them on a literal.
 */
describe("Earn strategy reads — shipped V1 curation", () => {
  async function shippedCuratedVaults() {
    const actual = await vi.importActual<typeof import("@/routes/earn/handlers/curation")>(
      "@/routes/earn/handlers/curation"
    );
    return actual.CURATED_VAULTS;
  }

  it("shows only the curated mainnet shelf on the mirrored view", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const shelf = (await shippedCuratedVaults())["mainnet-beta"]?.kamino ?? [];
    expect(shelf.length).toBeGreaterThan(0);

    const curated = await seedStrategy({
      providerReference: shelf[0],
      hostCluster: "mainnet-beta",
    });
    const uncurated = await seedStrategy({
      providerReference: "some-vault-bd-did-not-pick",
      hostCluster: "mainnet-beta",
    });

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([curated.id]);
    expect(body.data.total).toBe(1);

    expect((await getEarn(`/v1/earn/strategies/${uncurated.id}`)).status).toBe(404);
    expect((await getEarn(`/v1/earn/strategies/${curated.id}`)).status).toBe(200);
  });

  it("shows only the curated devnet shelf on the sandbox default view", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const shelf = (await shippedCuratedVaults()).devnet?.kamino ?? [];
    expect(shelf.length).toBeGreaterThan(0);

    const curated = await seedStrategy({ providerReference: shelf[0] });
    await seedStrategy({ providerReference: "devnet-vault-not-picked" });

    const list = await getEarn("/v1/earn/strategies");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([curated.id]);
    expect(body.data.total).toBe(1);
  });

  /**
   * The Jupiter Lend exclusion is a name TERM, so it must hold even in the
   * worst case: a row squatting a curated address. Terms can exclusively
   * REMOVE rows, which is what makes stacking them on the allowlist safe.
   */
  it("hides a Jupiter Lend row even when it carries a curated address", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const shelf = (await shippedCuratedVaults()).devnet?.kamino ?? [];

    const jupiter = await seedStrategy({
      providerReference: shelf[0],
      name: "Jupiter Lend USDC",
    });

    const list = await getEarn("/v1/earn/strategies");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { strategies: Array<{ id: string }> } };
    expect(body.data.strategies).toEqual([]);
    expect((await getEarn(`/v1/earn/strategies/${jupiter.id}`)).status).toBe(404);
  });
});
