import { EARN_PROVIDER_CLIENTS } from "@sdp/earn";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnPositionRow,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const VEDA_SANDBOX_KEY = "veda-sandbox-test-api-key";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalVedaSandboxApiKey: string | undefined;

/**
 * Earn provider entitlement defaults to OFF for every organization
 * (GENERAL_PROVIDER_DEFAULTS.earn is empty), so the deposit-side availability
 * gate needs an explicit org-settings override; `entitleVeda: false` seeds an
 * organization without one.
 */
async function seedAuth({ entitleVeda = true }: { entitleVeda?: boolean } = {}): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  const settings = entitleVeda
    ? JSON.stringify({ providerOverrides: { earn: { veda: true } } })
    : null;

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active", settings),
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

async function seedPosition(
  strategyId: string,
  walletId: string,
  status: "active" | "closed" = "active"
): Promise<EarnPositionRow> {
  const position = await createPostgresEarnRepository(getDb(env)).createPosition({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    strategyId,
    walletId,
  });
  if (!position) {
    throw new Error("Failed to seed earn position");
  }
  if (status === "closed") {
    // The repository exposes no close-position mutation yet (that lands with
    // execution endpoints), so tests flip the row directly.
    await getDb(env)
      .prepare("UPDATE earn_positions SET status = 'closed' WHERE id = ?")
      .bind(position.id)
      .run();
  }
  return position;
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

function postEarn(path: string, body: Record<string, unknown>) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalVedaSandboxApiKey = env.VEDA_SANDBOX_API_KEY;
  // Earn is a Markets sub-module, so both gates have to be on to reach a route.
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  // Sandbox credentials so the provider-configured gates pass; provider HTTP
  // itself is stubbed per-test via EARN_PROVIDER_CLIENTS spies.
  env.VEDA_SANDBOX_API_KEY = VEDA_SANDBOX_KEY;
  await seedTestDatabase(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.VEDA_SANDBOX_API_KEY = originalVedaSandboxApiKey;
  await clearTestDatabase(env);
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

describe("Earn routes — quote exit safety (ADR 0002)", () => {
  it("blocks deposit quotes on a paused strategy but still quotes withdrawals from it", async () => {
    await seedAuth();
    const paused = await seedStrategy({ status: "paused" });
    const quoteDeposit = vi.spyOn(EARN_PROVIDER_CLIENTS.veda, "quoteDeposit").mockResolvedValue({
      provider: "veda",
      strategyProviderReference: paused.provider_reference,
      expectedShareAmount: "980000",
    });
    const quoteWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.veda, "quoteWithdrawal")
      .mockResolvedValue({
        provider: "veda",
        strategyProviderReference: paused.provider_reference,
        expectedAmount: "1000000",
        sharePrice: "1.02",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

    const deposit = await postEarn("/v1/earn/deposits/quote", {
      strategyId: paused.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
    });

    expect(deposit.status).toBe(409);
    const depositBody = (await deposit.json()) as { error: { code: string } };
    expect(depositBody.error.code).toBe("STRATEGY_NOT_AVAILABLE");
    expect(quoteDeposit).not.toHaveBeenCalled();

    // Money out beats money off: pausing stops deposits, never withdrawals.
    const withdrawal = await postEarn("/v1/earn/withdrawals/quote", {
      strategyId: paused.id,
      tokenMint: USDC_MINT,
      shareAmount: "980000",
    });

    expect(withdrawal.status).toBe(200);
    const withdrawalBody = (await withdrawal.json()) as {
      data: { quote: Record<string, unknown> };
    };
    expect(withdrawalBody.data.quote).toEqual({
      provider: "veda",
      strategyId: paused.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
      shareAmount: "980000",
      sharePrice: "1.02",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(quoteWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      expect.objectContaining({
        strategyProviderReference: paused.provider_reference,
        tokenMint: USDC_MINT,
        shareAmount: "980000",
      })
    );
  });

  it("keeps withdrawals quotable when the organization loses deposit entitlement", async () => {
    await seedAuth({ entitleVeda: false });
    const strategy = await seedStrategy();
    vi.spyOn(EARN_PROVIDER_CLIENTS.veda, "quoteWithdrawal").mockResolvedValue({
      provider: "veda",
      strategyProviderReference: strategy.provider_reference,
      expectedAmount: "1000000",
    });

    const deposit = await postEarn("/v1/earn/deposits/quote", {
      strategyId: strategy.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
    });

    expect(deposit.status).toBe(403);
    const depositBody = (await deposit.json()) as { error: { message: string } };
    expect(depositBody.error.message).toContain("manual activation");

    const withdrawal = await postEarn("/v1/earn/withdrawals/quote", {
      strategyId: strategy.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
    });

    expect(withdrawal.status).toBe(200);
  });

  it("quotes deposits on an active strategy through the provider client", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const quoteDeposit = vi.spyOn(EARN_PROVIDER_CLIENTS.veda, "quoteDeposit").mockResolvedValue({
      provider: "veda",
      strategyProviderReference: strategy.provider_reference,
      expectedShareAmount: "980000",
      sharePrice: "1.02",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const res = await postEarn("/v1/earn/deposits/quote", {
      strategyId: strategy.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { quote: Record<string, unknown> } };
    expect(body.data.quote).toEqual({
      provider: "veda",
      strategyId: strategy.id,
      tokenMint: USDC_MINT,
      amount: "1000000",
      shareAmount: "980000",
      sharePrice: "1.02",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(quoteDeposit).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      strategyProviderReference: strategy.provider_reference,
      tokenMint: USDC_MINT,
      amount: "1000000",
    });
  });

  it("rejects deposit quotes for a mint the strategy does not accept", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await postEarn("/v1/earn/deposits/quote", {
      strategyId: strategy.id,
      tokenMint: USDT_MINT,
      amount: "1000000",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain(`does not accept mint ${USDT_MINT}`);
  });
});

describe("Earn routes — positions", () => {
  it("excludes closed positions unless includeClosed=true", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const active = await seedPosition(strategy.id, "wal_earn_active");
    const closed = await seedPosition(strategy.id, "wal_earn_closed", "closed");

    const defaultList = await getEarn("/v1/earn/positions");
    expect(defaultList.status).toBe(200);
    const defaultBody = (await defaultList.json()) as {
      data: { positions: Array<{ id: string }>; total: number; page: number; pageSize: number };
    };
    expect(defaultBody.data.positions.map((p) => p.id)).toEqual([active.id]);
    expect(defaultBody.data.total).toBe(1);

    const withClosed = await getEarn("/v1/earn/positions?includeClosed=true");
    expect(withClosed.status).toBe(200);
    const withClosedBody = (await withClosed.json()) as {
      data: { positions: Array<{ id: string }>; total: number };
    };
    expect(withClosedBody.data.positions.map((p) => p.id).sort()).toEqual(
      [active.id, closed.id].sort()
    );
    expect(withClosedBody.data.total).toBe(2);
  });

  it("rejects non-boolean includeClosed values instead of coercing them", async () => {
    await seedAuth();

    // z.coerce.boolean() would have turned "1" — and even "false" — into
    // true; the strict flag schema must 400 instead of inverting intent.
    const rejected = await getEarn("/v1/earn/positions?includeClosed=1");
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");

    const explicitFalse = await getEarn("/v1/earn/positions?includeClosed=false");
    expect(explicitFalse.status).toBe(200);
  });
});
