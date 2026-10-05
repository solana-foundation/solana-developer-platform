import assert from "node:assert/strict";
import { hashString } from "@sdp/payments/hash";
import { type CachedApiKey, type SolanaCluster, wellKnownMint } from "@sdp/types";
import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { required } from "@/test/helpers/required";

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
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, readRateLimitCount, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_test_earn_routes",
  name: "Earn Routes Org",
  slug: "earn-routes",
};
const TEST_PROJECT = {
  id: "prj_test_earn_routes",
  slug: "test-earn-routes-project",
};
const TEST_USER = {
  id: "usr_test_earn_routes",
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
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
  });
  await getDb(env).batch([
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

async function seedClerkAuth(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'member', 'active')`
      )
      .bind("om_earn_routes_Clerk", TEST_ORG.id, TEST_USER.id),
  ]);
}

async function seedStrategy(overrides: Partial<UpsertEarnStrategyInput>): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
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
  assert(strategy);
  return strategy;
}

async function seedProgram(): Promise<EarnProviderWalletRow> {
  const row = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "upshift",
    providerWalletRef: crypto.randomUUID(),
    label: null,
    createdBy: TEST_USER.id,
  });
  assert(row);
  return row;
}

function getEarn(path: string, headers: Record<string, string>) {
  return app.request(
    path,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${TEST_API_KEY.raw}`, ...headers },
    },
    env
  );
}

function getEarnAnonymously(path: string, headers: Record<string, string>) {
  return app.request(path, { method: "GET", headers }, env);
}

async function getEarnAsClerk(path: string, projectId: string) {
  return app.request(
    path,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
        "x-project-id": projectId,
      },
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;

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

    const res = await getEarn("/v1/earn/strategies", {});

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Earn is not enabled");
  });

  it("returns 403 while MARKETS_ENABLED is off even though EARN_ENABLED is on", async () => {
    env.MARKETS_ENABLED = undefined;
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies", {});

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Earn is not enabled");
  });

  it("serves the same route once EARN_ENABLED is true", async () => {
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies", {});

    expect(res.status).toBe(200);
  });
});

describe("Earn routes — retired surfaces stay retired (PRO-1628)", () => {
  it("serves 404 for the removed positions/movements/quotes/nav routes", async () => {
    await seedAuth();

    const strategy = await seedStrategy({});

    for (const path of [
      "/v1/earn/positions",
      "/v1/earn/positions/pos_1",

      "/v1/earn/movements/mov_1",
      `/v1/earn/strategies/${strategy.id}/nav`,

      "/v1/earn/button-configurations/current",
      "/v1/earn/button-configurations/public/AbCdEfGhIjKlMnOpQrStUvWx",
    ]) {
      const res = await getEarn(path, {});
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
    await seedAuth();

    const res = await getEarn("/v1/earn/movements", {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { movements: unknown[]; hasMore: boolean; nextCursor: string | null };
    };
    expect(body.data).toEqual({ movements: [], hasMore: false, nextCursor: null });
  });
});

describe("Earn routes — retired program surfaces (PRO-1670)", () => {
  it("serves 404 for the singular /program paths, while the collection answers", async () => {
    await seedAuth();

    for (const path of [
      "/v1/earn/program",
      "/v1/earn/program?provider=upshift",
      "/v1/earn/program/deposits",
      "/v1/earn/program/withdrawals",
      "/v1/earn/program/withdrawals/wd_x",
    ]) {
      const res = await getEarn(path, {});
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

    const collection = await getEarn("/v1/earn/programs", {});
    expect(collection.status).toBe(200);
    const body = (await collection.json()) as {
      data: { programs: unknown[]; total: number; page: number; pageSize: number };
    };
    expect(body.data).toEqual({ programs: [], total: 0, page: 1, pageSize: 20 });
  });

  it("routes the per-program sub-paths under a real program id", async () => {
    await seedAuth();
    const program = await seedProgram();

    for (const path of ["/v1/earn/program/deposits", "/v1/earn/program/withdrawals"]) {
      const res = await getEarn(path, {});
      expect(res.status, path).toBe(404);
    }

    const ledger = await getEarn(`/v1/earn/programs/${program.id}/withdrawals`, {});
    expect(ledger.status).toBe(200);
    const ledgerBody = (await ledger.json()) as {
      data: { withdrawals: unknown[]; total: number };
    };
    expect(ledgerBody.data.withdrawals).toEqual([]);
    expect(ledgerBody.data.total).toBe(0);

    const unknownProgram = await getEarn(
      "/v1/earn/programs/earn_provider_wallet_nope/withdrawals",
      {}
    );
    expect(unknownProgram.status).toBe(404);
  });
});

describe("Earn routes — environment scoping", () => {
  it("hides production strategies from a sandbox API key", async () => {
    await seedAuth();
    const sandbox = await seedStrategy({});
    const production = await seedStrategy({ environment: "production" });

    const visible = await getEarn(`/v1/earn/strategies/${sandbox.id}`, {});
    expect(visible.status).toBe(200);

    const hidden = await getEarn(`/v1/earn/strategies/${production.id}`, {});
    expect(hidden.status).toBe(404);
    const hiddenBody = (await hidden.json()) as { error: { code: string } };
    expect(hiddenBody.error.code).toBe("NOT_FOUND");

    const list = await getEarn("/v1/earn/strategies", {});
    const listBody = (await list.json()) as { data: { strategies: Array<{ id: string }> } };
    expect(listBody.data.strategies.map((s) => s.id)).toEqual([sandbox.id]);
  });

  it("lets an anonymous caller pick the shelf, production unless it asks for sandbox", async () => {
    const sandbox = await seedStrategy({});
    const production = await seedStrategy({
      environment: "production",
      hostCluster: "mainnet-beta",
    });

    const defaulted = await getEarnAnonymously("/v1/earn/strategies", {});
    expect(defaulted.status).toBe(200);
    const defaultedBody = (await defaulted.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(defaultedBody.data.strategies.map((s) => s.id)).toEqual([production.id]);

    const sandboxShelf = await getEarnAnonymously("/v1/earn/strategies?environment=sandbox", {});
    expect(sandboxShelf.status).toBe(200);
    const sandboxBody = (await sandboxShelf.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(sandboxBody.data.strategies.map((s) => s.id)).toEqual([sandbox.id]);

    expect((await getEarnAnonymously(`/v1/earn/strategies/${sandbox.id}`, {})).status).toBe(200);
    expect((await getEarnAnonymously(`/v1/earn/strategies/${production.id}`, {})).status).toBe(200);
  });

  it("refuses a key that names a shelf other than its project's", async () => {
    await seedAuth();
    await seedStrategy({});

    const mismatch = await getEarn("/v1/earn/strategies?environment=production", {});
    expect(mismatch.status).toBe(400);
    const mismatchBody = (await mismatch.json()) as { error: { code: string; message: string } };
    expect(mismatchBody.error.code).toBe("BAD_REQUEST");
    expect(mismatchBody.error.message).toContain("follows the project");

    const same = await getEarn("/v1/earn/strategies?environment=sandbox", {});
    expect(same.status).toBe(200);
  });

  it("publishes depositSlippage for the caller's environment, the same answer the build gates on", async () => {
    await seedAuth();
    await seedClerkAuth();
    const sandbox = await seedStrategy({});
    const production = await seedStrategy({
      environment: "production",
      hostCluster: "mainnet-beta",
    });

    const sandboxRow = await getEarn(`/v1/earn/strategies/${sandbox.id}`, {});
    expect(sandboxRow.status).toBe(200);
    const sandboxBody = (await sandboxRow.json()) as {
      data: { strategy: { provider: string; depositSlippage: unknown } };
    };
    expect(sandboxBody.data.strategy).toMatchObject({
      provider: "kamino",
      depositSlippage: null,
    });

    const productionRow = await getEarnAsClerk(
      `/v1/earn/strategies/${production.id}`,
      TEST_PRODUCTION_PROJECT.id
    );
    expect(productionRow.status).toBe(200);
    const productionBody = (await productionRow.json()) as {
      data: { strategy: { provider: string; depositSlippage: unknown } };
    };
    expect(productionBody.data.strategy).toMatchObject({
      provider: "kamino",
      depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
    });
  });
});

describe("Earn routes — Clerk-caller environment resolution", () => {
  it("scopes the catalogue to the Clerk's selected project environment", async () => {
    await seedAuth();
    await seedClerkAuth();
    const sandbox = await seedStrategy({});

    const production = await seedStrategy({
      environment: "production",
      hostCluster: "mainnet-beta",
    });

    const productionList = await getEarnAsClerk("/v1/earn/strategies", TEST_PRODUCTION_PROJECT.id);
    expect(productionList.status).toBe(200);
    const productionBody = (await productionList.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(productionBody.data.strategies.map((s) => s.id)).toEqual([production.id]);

    const hidden = await getEarnAsClerk(
      `/v1/earn/strategies/${sandbox.id}`,
      TEST_PRODUCTION_PROJECT.id
    );
    expect(hidden.status).toBe(404);

    const sandboxList = await getEarnAsClerk("/v1/earn/strategies", TEST_PROJECT.id);
    expect(sandboxList.status).toBe(200);
    const sandboxBody = (await sandboxList.json()) as {
      data: { strategies: Array<{ id: string }> };
    };
    expect(sandboxBody.data.strategies.map((s) => s.id)).toEqual([sandbox.id]);
  });
});

describe("Earn routes — strategy catalogue", () => {
  it("answers anonymous and keyed readers with the same public catalogue", async () => {
    await seedAuth();
    await seedStrategy({});
    const corsHeaders = { Origin: "http://localhost:3000" };

    const anonymous = await getEarnAnonymously(
      "/v1/earn/strategies?environment=sandbox",
      corsHeaders
    );
    const keyed = await getEarn("/v1/earn/strategies", corsHeaders);

    expect(anonymous.status).toBe(200);
    expect(keyed.status).toBe(200);
    const anonymousBody = (await anonymous.json()) as { data: unknown };
    const keyedBody = (await keyed.json()) as { data: unknown };
    expect(anonymousBody.data).toEqual(keyedBody.data);
    expect(anonymous.headers.get("cache-control")).toBe(
      "public, max-age=30, stale-while-revalidate=30"
    );
    expect(keyed.headers.get("cache-control")).toBe("private, max-age=30");
    expect(anonymous.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(keyed.headers.get("access-control-allow-origin")).toBe(
      anonymous.headers.get("access-control-allow-origin")
    );
  });

  it("keeps hidden and unsurfaced strategies out of the anonymous catalogue", async () => {
    const visible = await seedStrategy({ providerReference: "anonymous-visible-usdc" });
    const hiddenByTerms = await seedStrategy({
      providerReference: "anonymous-morpho-usdc",
      name: "Morpho USDC",
      underlyingSource: "morpho",
    });
    const hiddenByProvider = await seedStrategy({
      provider: "upshift",
      providerReference: "anonymous-upshift-usdc",
      name: "Upshift USDC",
    });

    const list = await getEarnAnonymously("/v1/earn/strategies?environment=sandbox", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((strategy) => strategy.id)).toEqual([visible.id]);
    expect(body.data.total).toBe(1);
    expect((await getEarnAnonymously(`/v1/earn/strategies/${hiddenByTerms.id}`, {})).status).toBe(
      404
    );
    expect(
      (await getEarnAnonymously(`/v1/earn/strategies/${hiddenByProvider.id}`, {})).status
    ).toBe(404);
  });

  it("returns the paginated list envelope and omits non-active strategies", async () => {
    await seedAuth();
    const active = await seedStrategy({});
    await seedStrategy({ status: "paused" });

    const res = await getEarn("/v1/earn/strategies", {});

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

  it("lists the environment's own cluster by default and the mirrored shelf on explicit opt-in", async () => {
    await seedAuth();
    const local = await seedStrategy({ hostCluster: "devnet" });
    const mirrored = await seedStrategy({ hostCluster: "mainnet-beta" });

    const defaults = await getEarn("/v1/earn/strategies", {});
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

      feeSponsored: false,
    });

    expect(defaultBody.data.total).toBe(1);

    const optIn = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(optIn.status).toBe(200);
    const optInBody = (await optIn.json()) as {
      data: {
        strategies: Array<{ id: string; hostCluster: string; fundable: boolean }>;
        total: number;
      };
    };
    expect(optInBody.data.strategies.map((s) => s.id)).toEqual([mirrored.id]);

    expect(optInBody.data.strategies[0]).toMatchObject({
      hostCluster: "mainnet-beta",
      fundable: false,
      feeSponsored: false,
    });
    expect(optInBody.data.total).toBe(1);
  });

  it("derives feeSponsored per request from the sponsorship gate and the row's cluster", async () => {
    await seedAuth();
    const local = await seedStrategy({ provider: "kamino", hostCluster: "devnet" });
    const mirrored = await seedStrategy({ provider: "kamino", hostCluster: "mainnet-beta" });
    const original = env.EARN_VAULT_FEE_SPONSORSHIP_ENABLED;
    env.EARN_VAULT_FEE_SPONSORSHIP_ENABLED = "true";
    try {
      const list = await getEarn("/v1/earn/strategies", {});
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        data: { strategies: Array<{ id: string; fundable: boolean; feeSponsored: boolean }> };
      };
      expect(listBody.data.strategies).toEqual([
        expect.objectContaining({ id: local.id, fundable: true, feeSponsored: true }),
      ]);

      const detail = await getEarn(`/v1/earn/strategies/${local.id}`, {});
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { data: { strategy: { feeSponsored: boolean } } };
      expect(detailBody.data.strategy.feeSponsored).toBe(true);

      const optIn = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
      const optInBody = (await optIn.json()) as {
        data: { strategies: Array<{ id: string; fundable: boolean; feeSponsored: boolean }> };
      };
      expect(optInBody.data.strategies).toEqual([
        expect.objectContaining({ id: mirrored.id, fundable: false, feeSponsored: false }),
      ]);
    } finally {
      env.EARN_VAULT_FEE_SPONSORSHIP_ENABLED = original;
    }
  });

  it("rejects a cluster value outside the Solana cluster vocabulary", async () => {
    await seedAuth();

    const res = await getEarn("/v1/earn/strategies?cluster=testnet", {});

    expect(res.status).toBe(400);
  });

  it("carries hostCluster and fundable on the single-strategy read too", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });

    const res = await getEarn(`/v1/earn/strategies/${strategy.id}`, {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { strategy: { hostCluster: string; fundable: boolean } };
    };
    expect(body.data.strategy).toMatchObject({ hostCluster: "mainnet-beta", fundable: false });
  });

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

      underlyingSource: null,
    });

    const repository = createPostgresEarnRepository(getDb(env));
    expect(await repository.getStrategyById(morpho.id)).not.toBeNull();
    expect(await repository.getStrategyById(aave.id)).not.toBeNull();

    const list = await getEarn("/v1/earn/strategies?pageSize=1", {});
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number; pageSize: number };
    };
    expect(listBody.data.strategies.map((strategy) => strategy.id)).toEqual([visible.id]);
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.pageSize).toBe(1);

    for (const hidden of [morpho, aave]) {
      const detail = await getEarn(`/v1/earn/strategies/${hidden.id}`, {});
      expect(detail.status).toBe(404);
    }
  });

  it("stores an un-surfaced provider's rows but never returns them from strategy reads", async () => {
    await seedAuth();
    const surfaced = await seedStrategy({ providerReference: "kamino-visible-usdc" });
    const unsurfaced = await seedStrategy({
      provider: "upshift",
      providerReference: "upshift-hidden-usdc",
      name: "Upshift Institutional USDC",
      underlyingSource: "centrifuge",
    });

    const repository = createPostgresEarnRepository(getDb(env));
    expect(await repository.getStrategyById(unsurfaced.id)).not.toBeNull();

    const list = await getEarn("/v1/earn/strategies", {});
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(listBody.data.strategies.map((strategy) => strategy.id)).toEqual([surfaced.id]);

    expect(listBody.data.total).toBe(1);

    const detail = await getEarn(`/v1/earn/strategies/${unsurfaced.id}`, {});
    expect(detail.status).toBe(404);
  });
});

describe("Earn route middleware isolation", () => {
  it("charges an authenticated keyed-only route exactly once", async () => {
    await seedAuth();

    const res = await getEarn("/v1/earn/movements", {});

    expect(res.status).toBe(200);
    expect(await readRateLimitCount(env, TEST_API_KEY.id)).toBe(1);
  });
});

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
    const shelf = required(required((await shippedCuratedVaults())["mainnet-beta"]).kamino);
    expect(shelf.length).toBeGreaterThan(0);

    const curated = await seedStrategy({
      providerReference: shelf[0],
      hostCluster: "mainnet-beta",
    });
    const uncurated = await seedStrategy({
      providerReference: "some-vault-bd-did-not-pick",
      hostCluster: "mainnet-beta",
    });

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([curated.id]);
    expect(body.data.total).toBe(1);

    expect((await getEarn(`/v1/earn/strategies/${uncurated.id}`, {})).status).toBe(404);
    expect((await getEarn(`/v1/earn/strategies/${curated.id}`, {})).status).toBe(200);
  });

  it("shows only the curated devnet shelf on the sandbox default view", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const shelf = required(required((await shippedCuratedVaults()).devnet).kamino);
    expect(shelf.length).toBeGreaterThan(0);

    const curated = await seedStrategy({ providerReference: shelf[0] });
    await seedStrategy({ providerReference: "devnet-vault-not-picked" });

    const list = await getEarn("/v1/earn/strategies", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([curated.id]);
    expect(body.data.total).toBe(1);
  });

  it("keeps the hidden Ethena PYUSD vaults off every strategy read", async () => {
    await seedAuth();

    const actual = await vi.importActual<typeof import("@/routes/earn/handlers/curation")>(
      "@/routes/earn/handlers/curation"
    );
    const hiddenClusters = Object.entries(actual.HIDDEN_VAULTS).map(([cluster, keys]) => ({
      cluster: cluster as SolanaCluster,
      keys,
    }));
    assert(!hiddenClusters.some(({ keys }) => keys.length === 0));

    const hidden: EarnStrategyRow[] = [];
    for (const { cluster, keys } of hiddenClusters) {
      for (const key of keys) {
        const reference = key.split(":")[1];
        assert(reference);
        hidden.push(await seedStrategy({ providerReference: reference, hostCluster: cluster }));
      }
    }

    const assertAllHidden = async () => {
      for (const { cluster } of hiddenClusters) {
        const path =
          cluster === "devnet" ? "/v1/earn/strategies" : `/v1/earn/strategies?cluster=${cluster}`;
        const list = await getEarn(path, {});
        expect(list.status).toBe(200);
        const body = (await list.json()) as {
          data: { strategies: Array<{ id: string }>; total: number };
        };
        expect(body.data.strategies).toEqual([]);
        expect(body.data.total).toBe(0);
      }
      for (const strategy of hidden) {
        expect((await getEarn(`/v1/earn/strategies/${strategy.id}`, {})).status).toBe(404);
      }
    };

    curation.bypassCuratedVaults = true;
    await assertAllHidden();

    curation.bypassCuratedVaults = false;
    await assertAllHidden();

    const repository = createPostgresEarnRepository(getDb(env));
    for (const strategy of hidden) {
      expect(await repository.getStrategyById(strategy.id)).not.toBeNull();
    }
  });

  it("serves the restored Sentora PYUSD vault and still hides Ethena PYUSD Prime", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const sentora = await seedStrategy({
      providerReference: "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK",
      hostCluster: "mainnet-beta",
    });
    const ethena = await seedStrategy({
      providerReference: "4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf",
      hostCluster: "mainnet-beta",
    });

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { strategies: Array<{ id: string }>; total: number };
    };
    expect(body.data.strategies.map((s) => s.id)).toEqual([sentora.id]);
    expect(body.data.total).toBe(1);
    expect((await getEarn(`/v1/earn/strategies/${sentora.id}`, {})).status).toBe(200);
    expect((await getEarn(`/v1/earn/strategies/${ethena.id}`, {})).status).toBe(404);
  });

  it("publishes the Kamino deposit floor required by production builds", async () => {
    curation.bypassCuratedVaults = true;
    await seedAuth();
    const kamino = await seedStrategy({ hostCluster: "mainnet-beta" });

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        strategies: Array<{
          id: string;
          depositSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
          withdrawalSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
        }>;
      };
    };
    expect(body.data.strategies).toEqual([
      expect.objectContaining({
        id: kamino.id,
        depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
        withdrawalSlippage: null,
      }),
    ]);
  });

  it("shows the supported Jupiter Lend provider independently of Kamino's allowlist", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const jupiter = await seedStrategy({
      provider: "jupiter_lend",
      providerReference: JUPITER_LEND_USDT.assetMint,
      name: "Jupiter Lend USDT",
      underlyingSource: "Jupiter Lend",
      depositMints: [JUPITER_LEND_USDT.assetMint],
      shareMint: JUPITER_LEND_USDT.shareMint,
      hostCluster: "mainnet-beta",
    });

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        strategies: Array<{
          id: string;
          depositSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
          withdrawalSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
        }>;
      };
    };
    expect(body.data.strategies.map((strategy) => strategy.id)).toEqual([jupiter.id]);
    expect(body.data.strategies[0]).toMatchObject({
      depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
      withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
    });
    expect((await getEarn(`/v1/earn/strategies/${jupiter.id}`, {})).status).toBe(200);
  });

  it("shows the Ondo USDY row uncurated, with the swap builder's 50 bps floors", async () => {
    curation.bypassCuratedVaults = false;
    await seedAuth();
    const usdyMint = required(ONDO_DEPLOYMENTS["mainnet-beta"]).usdyMint;
    assert(usdyMint);
    const ondo = await seedStrategy({
      provider: "ondo",
      providerReference: usdyMint,
      name: "Ondo USDY",
      sourceKind: "rwa",
      underlyingSource: "ondo-usdy",
      depositMints: [wellKnownMint("USDC", "mainnet-beta") as string],
      shareMint: usdyMint,
      currentApy: null,

      riskMetadata: {
        curator: "ondo",
        eligibility: "Reg S: non-US persons only; not enforced on-chain",
        issuerControls: "Ondo holds the USDY mint and freeze authority",
      },
      hostCluster: "mainnet-beta",
    });

    const own = await getEarn("/v1/earn/strategies", {});
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { data: { strategies: Array<{ id: string }> } }).data.strategies
    ).toEqual([]);

    const list = await getEarn("/v1/earn/strategies?cluster=mainnet-beta", {});
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        strategies: Array<{
          id: string;
          provider: string;
          sourceKind: string;
          fundable: boolean;
          currentApy?: string;
          riskMetadata: Record<string, unknown>;
          depositSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
          withdrawalSlippage: { quoteRequired: boolean; defaultToleranceBps: number } | null;
        }>;
      };
    };
    const disclosure = {
      curator: "ondo",
      eligibility: "Reg S: non-US persons only; not enforced on-chain",
      issuerControls: "Ondo holds the USDY mint and freeze authority",
    };
    expect(body.data.strategies.map((strategy) => strategy.id)).toEqual([ondo.id]);
    expect(body.data.strategies[0]).toMatchObject({
      provider: "ondo",
      sourceKind: "rwa",
      fundable: false,
      riskMetadata: disclosure,
      depositSlippage: { quoteRequired: true, defaultToleranceBps: 50 },
      withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 50 },
    });

    expect(required(body.data.strategies[0]).currentApy).toBeUndefined();

    const detail = await getEarn(`/v1/earn/strategies/${ondo.id}`, {});
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { strategy: { riskMetadata: Record<string, unknown> } };
    };
    expect(detailBody.data.strategy.riskMetadata).toEqual(disclosure);
  });
});
