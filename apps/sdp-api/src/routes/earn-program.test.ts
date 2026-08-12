import { EARN_PROVIDER_CLIENTS } from "@sdp/earn";
import { hashString } from "@sdp/payments/hash";
import type {
  CachedApiKey,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWithdrawal,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnProviderWalletRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import app from "@/index";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_earn_program",
  name: "Earn Program Org",
  slug: "earn-program",
};
const TEST_PROJECT = {
  id: "prj_test_earn_program",
  slug: "test-earn-program-project",
};
const TEST_USER = {
  id: "usr_earn_program",
  email: "earn-program@example.com",
};
const TEST_API_KEY = {
  id: "key_earn_program",
  raw: "sk_test_earn_program",
  prefix: "sk_test_epr",
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
  id: "prj_test_earn_program_prod",
  slug: "test-earn-program-project-prod",
};
const TEST_SESSION_ID = "ses_earn_program";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GROUND_SANDBOX_KEY = "ground-sandbox-test-api-key";
const GROUND_PRODUCTION_KEY = "ground-production-test-api-key";
const GROUND_SOURCE = "morpho-gauntlet-usdc";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const GROUND_USDT_SOURCE = "morpho-gauntlet-usdt";
const WALLET_REF = "8f14e45f-ceea-467f-9b6b-3c1a5c7f9d21";
const SOLANA_DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_ALLOCATIONS = { usdc: [{ yieldSourceId: GROUND_SOURCE, pct: 100 }] };

const WALLET_SNAPSHOT: EarnPortfolioWalletSnapshot = {
  providerWalletRef: WALLET_REF,
  status: "ready",
  providerStatus: "idle",
  solanaDepositAddress: SOLANA_DESTINATION,
  balance: {
    totalUsd: "100.00",
    withdrawableUsd: "90.00",
    reservedUsd: "10.00",
    earnedUsd: "1.23",
  },
  positions: [
    {
      kind: "yield_source",
      label: "Gauntlet USDC",
      valueUsd: "100.00",
      pct: 100,
      yieldSourceId: GROUND_SOURCE,
      token: "usdc",
    },
  ],
  allocations: { usdc: [{ yieldSourceId: GROUND_SOURCE, weightBps: 10_000 }] },
};

const WITHDRAWAL: EarnPortfolioWithdrawal = {
  withdrawalRef: "wd_test_1",
  status: "processing",
  amountRequestedUsd: "25.50",
  token: "usdc",
  destinationAddress: SOLANA_DESTINATION,
  createdAt: "2026-08-03T00:00:00.000Z",
};

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalGroundSandboxApiKey: string | undefined;
let originalGroundApiKey: string | undefined;

/**
 * Earn provider entitlement defaults to OFF for every organization, so the
 * deposit-side availability gate needs an explicit org-settings override;
 * `entitleGround: false` seeds an organization without one (the exit-safety
 * cases assert withdrawals keep working there).
 */
async function seedAuth({ entitleGround = true }: { entitleGround?: boolean } = {}): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  const settings = entitleGround
    ? JSON.stringify({ providerOverrides: { earn: { ground: true } } })
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
        "Earn Program Test Key",
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
      .bind("om_earn_program_session", TEST_ORG.id, TEST_USER.id),
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
      .bind("pm_earn_program_sandbox", TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_earn_program_production", TEST_PRODUCTION_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(TEST_SESSION_ID, TEST_USER.id, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
  ]);
}

async function seedGroundStrategy(overrides: Partial<UpsertEarnStrategyInput> = {}): Promise<void> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "ground",
    providerReference: GROUND_SOURCE,
    name: "Gauntlet USDC",
    sourceKind: "defi",
    underlyingSource: "morpho",
    depositMints: [USDC_MINT],
    shareMint: null,
    apyType: "variable",
    currentApy: "0.051",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: { curator: "gauntlet" },
    status: "active",
    environment: "sandbox",
    ...overrides,
  });
  if (!strategy) {
    throw new Error("Failed to seed ground strategy");
  }
}

async function seedProgramWallet(): Promise<EarnProviderWalletRow> {
  const row = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "ground",
    providerWalletRef: WALLET_REF,
    label: "Test Program",
    createdBy: TEST_USER.id,
  });
  if (!row) {
    throw new Error("Failed to seed earn program wallet");
  }
  return row;
}

function requestEarn(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    env
  );
}

function requestEarnAsSession(
  method: string,
  path: string,
  projectId: string,
  body?: Record<string, unknown>
) {
  return app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: `sdp_session=${TEST_SESSION_ID}`,
        "x-project-id": projectId,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalGroundSandboxApiKey = env.GROUND_SANDBOX_API_KEY;
  originalGroundApiKey = env.GROUND_API_KEY;
  // Earn is a Markets sub-module, so both gates have to be on to reach a route.
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  // Sandbox credentials so the provider-configured gates pass; provider HTTP
  // itself is stubbed per-test via EARN_PROVIDER_CLIENTS spies. The production
  // credential stays absent unless a test opts in.
  env.GROUND_SANDBOX_API_KEY = GROUND_SANDBOX_KEY;
  env.GROUND_API_KEY = undefined;
  await seedTestDatabase(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.GROUND_SANDBOX_API_KEY = originalGroundSandboxApiKey;
  env.GROUND_API_KEY = originalGroundApiKey;
  await clearKVStores(env);
});

describe("Earn program — PUT create-or-update", () => {
  it("provisions the shared wallet once, then updates strategy on later PUTs", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet").mockResolvedValue(WALLET_SNAPSHOT);

    const first = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      label: "Treasury",
      allocations: VALID_ALLOCATIONS,
    });

    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: {
        program: { provider: string; label: string | null; wallet: unknown };
        created: boolean;
      };
    };
    expect(firstBody.data.created).toBe(true);
    expect(firstBody.data.program.provider).toBe("ground");
    expect(firstBody.data.program.label).toBe("Treasury");
    expect(firstBody.data.program.wallet).toEqual(WALLET_SNAPSHOT);
    expect(createWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      label: "Treasury",
      allocations: VALID_ALLOCATIONS,
      requestId: undefined,
    });
    expect(updateStrategy).not.toHaveBeenCalled();

    // The ONE-wallet row is persisted for the org+environment+provider.
    const row = await createPostgresEarnRepository(getDb(env)).getProviderWallet({
      organizationId: TEST_ORG.id,
      environment: "sandbox",
      provider: "ground",
    });
    expect(row?.provider_wallet_ref).toBe(WALLET_REF);

    const second = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
    });

    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { created: boolean } };
    expect(secondBody.data.created).toBe(false);
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(updateStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      {
        providerWalletRef: WALLET_REF,
        allocations: VALID_ALLOCATIONS,
        requestId: undefined,
      }
    );
  });

  it("forwards a caller-minted requestId on both the create and update branches", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet").mockResolvedValue(WALLET_SNAPSHOT);

    // Without this key the provider mints its own per call, so a double-submitted
    // confirm fires two independent mutations.
    const createRequestId = "3f1d5a2e-9b64-4c7f-8a10-2d5e6f7a8b90";
    const updateRequestId = "5c2e7b41-8d36-4a92-bf05-1e4c9a7d3b28";

    const created = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
      requestId: createRequestId,
    });
    expect(created.status).toBe(201);
    expect(createWallet).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      expect.objectContaining({ requestId: createRequestId })
    );

    const updated = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
      requestId: updateRequestId,
    });
    expect(updated.status).toBe(200);
    expect(updateStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      expect.objectContaining({ requestId: updateRequestId })
    );
  });

  it("rejects a requestId that is not a UUIDv4", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
      requestId: "not-a-uuid",
    });

    expect(res.status).toBe(400);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects allocations referencing yield sources outside the synced catalogue", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: { usdc: [{ yieldSourceId: "morpho-unknown-usdc", pct: 100 }] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { unknownYieldSourceIds?: string[] } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.details?.unknownYieldSourceIds).toEqual(["morpho-unknown-usdc"]);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects more than one allocation entry per token group (V1 single-vault cap)", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    // Weights deliberately sum to 100 so the cap is the only violation.
    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: {
        usdc: [
          { yieldSourceId: GROUND_SOURCE, pct: 50 },
          { yieldSourceId: "morpho-steakhouse-usdc", pct: 50 },
        ],
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("exactly one allocation entry per token group");
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects a lone allocation entry whose weight is not 100", async () => {
    await seedAuth();
    await seedGroundStrategy();

    // With the group capped at one entry, the sum rule pins that entry to 100.
    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: { usdc: [{ yieldSourceId: GROUND_SOURCE, pct: 60 }] },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("sum to exactly 100");
  });

  it("accepts one entry per token group across both deposit tokens", async () => {
    await seedAuth();
    await seedGroundStrategy();
    await seedGroundStrategy({
      providerReference: GROUND_USDT_SOURCE,
      name: "Gauntlet USDT",
      depositMints: [USDT_MINT],
    });
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet").mockResolvedValue(WALLET_SNAPSHOT);

    // The cap is per token group, not per body: usdc and usdt each carry one vault.
    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: {
        usdc: [{ yieldSourceId: GROUND_SOURCE, pct: 100 }],
        usdt: [{ yieldSourceId: GROUND_USDT_SOURCE, pct: 100 }],
      },
    });

    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalledTimes(1);
  });

  it("blocks PUT when the organization is not entitled or credentials are missing", async () => {
    await seedAuth({ entitleGround: false });
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const unentitled = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
    });
    expect(unentitled.status).toBe(403);

    // Entitlement present but the sandbox credential missing also fails closed.
    await clearKVStores(env);
    await seedTestDatabase(env);
    await seedAuth();
    await seedGroundStrategy();
    env.GROUND_SANDBOX_API_KEY = undefined;

    const unconfigured = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
    });
    expect(unconfigured.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("returns 501 for providers without the portfolio-wallet capability", async () => {
    await seedAuth();

    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "veda",
      allocations: VALID_ALLOCATIONS,
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("Earn program — session callers and environment isolation", () => {
  it("creates a production program from a production-project dashboard session", async () => {
    await seedAuth();
    await seedSessionAuth();
    env.GROUND_API_KEY = GROUND_PRODUCTION_KEY;
    await seedGroundStrategy({ environment: "production" });
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet").mockResolvedValue(WALLET_SNAPSHOT);

    const res = await requestEarnAsSession("PUT", "/v1/earn/program", TEST_PRODUCTION_PROJECT.id, {
      provider: "ground",
      allocations: VALID_ALLOCATIONS,
    });

    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production" }),
      expect.objectContaining({ allocations: VALID_ALLOCATIONS })
    );

    // The ONE-wallet row lands under production with no sandbox sibling…
    const repo = createPostgresEarnRepository(getDb(env));
    const productionRow = await repo.getProviderWallet({
      organizationId: TEST_ORG.id,
      environment: "production",
      provider: "ground",
    });
    expect(productionRow?.provider_wallet_ref).toBe(WALLET_REF);
    expect(productionRow?.environment).toBe("production");
    expect(
      await repo.getProviderWallet({
        organizationId: TEST_ORG.id,
        environment: "sandbox",
        provider: "ground",
      })
    ).toBeNull();

    // …so the org's sandbox API key cannot see the production program.
    const sandboxView = await requestEarn("GET", "/v1/earn/program?provider=ground");
    expect(sandboxView.status).toBe(404);
  });

  it("never serves the sandbox program to a production-project session", async () => {
    await seedAuth();
    await seedSessionAuth();
    await seedProgramWallet();
    const getWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet")
      .mockResolvedValue(WALLET_SNAPSHOT);

    // requireProgramWallet keys on (org, environment, provider), so the
    // production-project session finds nothing — 404, no cross-read.
    const production = await requestEarnAsSession(
      "GET",
      "/v1/earn/program?provider=ground",
      TEST_PRODUCTION_PROJECT.id
    );
    expect(production.status).toBe(404);

    // The sandbox-project session still reads the org's program, unchanged.
    const sandbox = await requestEarnAsSession(
      "GET",
      "/v1/earn/program?provider=ground",
      TEST_PROJECT.id
    );
    expect(sandbox.status).toBe(200);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });
});

describe("Earn program — live reads", () => {
  it("returns 404 while no program wallet exists", async () => {
    await seedAuth();

    const res = await requestEarn("GET", "/v1/earn/program?provider=ground");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("serves the live provider snapshot for an existing program", async () => {
    await seedAuth();
    await seedProgramWallet();
    const getWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet")
      .mockResolvedValue(WALLET_SNAPSHOT);

    const res = await requestEarn("GET", "/v1/earn/program?provider=ground");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { program: { provider: string; label: string | null; wallet: unknown } };
    };
    expect(body.data.program.provider).toBe("ground");
    expect(body.data.program.label).toBe("Test Program");
    expect(body.data.program.wallet).toEqual(WALLET_SNAPSHOT);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });

  it("passes deposit pagination cursors through to the provider", async () => {
    await seedAuth();
    await seedProgramWallet();
    const listDeposits = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "listPortfolioDeposits")
      .mockResolvedValue({
        deposits: [
          {
            id: "dep_1",
            amountUsd: "50.00",
            token: "usdc",
            status: "completed",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        nextCursor: "cursor-2",
      });

    const res = await requestEarn(
      "GET",
      "/v1/earn/program/deposits?provider=ground&cursor=cursor-1"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deposits: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.deposits.map((d) => d.id)).toEqual(["dep_1"]);
    expect(body.data.nextCursor).toBe("cursor-2");
    expect(listDeposits).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
      cursor: "cursor-1",
    });
  });
});

describe("Earn program — withdrawals (ADR 0002 exit safety)", () => {
  it("keeps withdrawals and previews working when the organization loses deposit entitlement", async () => {
    await seedAuth({ entitleGround: false });
    await seedProgramWallet();
    const preview = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "previewPortfolioWithdrawal")
      .mockResolvedValue({
        amountRequestedUsd: "25.50",
        feeUsd: "0.10",
        withdrawableUsd: "90.00",
        totalUsdAfterWithdrawal: "74.40",
      });
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const previewRes = await requestEarn("POST", "/v1/earn/program/withdrawal-preview", {
      provider: "ground",
      amountUsd: "25.50",
      token: "usdc",
    });
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { data: { preview: { feeUsd: string } } };
    expect(previewBody.data.preview.feeUsd).toBe("0.10");
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
      amountUsd: "25.50",
      token: "usdc",
    });

    const withdrawalRes = await requestEarn("POST", "/v1/earn/program/withdrawals", {
      provider: "ground",
      // Money-out still gates on credentials alone; the key is a retry-safety
      // requirement every caller carries, not an entitlement check.
      requestId: "5b0e0c9a-7f3d-4a21-9c46-2f8ab1d5e740",
      amountUsd: "25.50",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
    });
    expect(withdrawalRes.status).toBe(201);
    const withdrawalBody = (await withdrawalRes.json()) as {
      data: { withdrawal: { withdrawalRef: string; status: string } };
    };
    expect(withdrawalBody.data.withdrawal).toEqual(WITHDRAWAL);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);

    const statusRes = await requestEarn(
      "GET",
      `/v1/earn/program/withdrawals/${WITHDRAWAL.withdrawalRef}?provider=ground`
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { data: { withdrawal: { status: string } } };
    expect(statusBody.data.withdrawal.status).toBe("processing");
  });

  // The provider dedupes a withdrawal on its request id, and since PRO-1628
  // that same derived id also anchors the SDP-side intent row — a two-layer
  // defence. Every case here exists to keep the id stable across attempts and
  // to prove a replay never reaches the provider as a second create.
  describe("withdrawal idempotency", () => {
    const withdrawalBody = (extra: Record<string, unknown> = {}) => ({
      provider: "ground",
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
      ...extra,
    });

    it("resolves a caller-key retry from the ledger: one provider create, replay served live", async () => {
      await seedAuth();
      await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);
      const getWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      // Every org shares one provider account, so a key that reached the
      // provider verbatim would let two tenants collide on the same pasted
      // UUID — one of them getting the other's withdrawal replayed back.
      const callerKey = "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d";
      const first = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody({ requestId: callerKey })
      );
      const retry = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody({ requestId: callerKey })
      );

      expect(first.status).toBe(201);
      // The retry is a REPLAY: nothing was created, so it answers 200 with
      // live provider state and never re-sends the create.
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as { data: { withdrawal: { status: string } } };
      expect(retryBody.data.withdrawal.status).toBe("processing");
      expect(createWithdrawal).toHaveBeenCalledTimes(1);
      expect(getWithdrawal).toHaveBeenCalledTimes(1);
      const sent = createWithdrawal.mock.calls[0]?.[1]?.requestId;
      expect(sent).not.toBe(callerKey);
      expect(sent).toMatch(UUID_V4_PATTERN);

      // Exactly ONE intent row anchors both attempts.
      const count = await getDb(env)
        .prepare("SELECT COUNT(*)::int AS total FROM earn_program_withdrawals")
        .first<{ total: number }>();
      expect(count?.total).toBe(1);
    });

    it("sends a key no other organization could produce from the same input", async () => {
      await seedAuth();
      await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      // The boilerplate case: every tenant pastes the same placeholder UUID.
      // One provider account serves them all, so an unscoped key would make
      // the second tenant's withdrawal collide with the first's. (A v4-shaped
      // placeholder — the RFC's own 123e4567… example is v1 and the schema
      // rejects it outright.)
      const shared = "00000000-0000-4000-8000-000000000000";
      const res = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody({ requestId: shared })
      );

      expect(res.status).toBe(201);
      const sent = createWithdrawal.mock.calls[0]?.[1]?.requestId;
      expect(sent).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], shared));
      // A different program wallet — i.e. any other org — cannot reach it.
      expect(sent).not.toBe(
        deriveProviderRequestId(["earn_program_withdrawal", "another-org-wallet"], shared)
      );
    });

    it("re-drives a crash-window retry with the SAME derived key from one Idempotency-Key", async () => {
      await seedAuth();
      await seedProgramWallet();
      // First attempt: the provider call dies after the intent row was
      // written (network blip, process crash — the ref-less window).
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(WITHDRAWAL);

      const headers = { "Idempotency-Key": "checkout-9f2b" };
      const first = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody(),
        headers
      );
      expect(first.status).toBe(500);
      // The intent row survives the failure, ref-less and re-drivable.
      const stranded = await getDb(env)
        .prepare(
          "SELECT status, provider_reference FROM earn_program_withdrawals ORDER BY created_at DESC"
        )
        .first<{ status: string; provider_reference: string | null }>();
      expect(stranded).toEqual({ status: "requested", provider_reference: null });

      const retry = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody(),
        headers
      );

      expect(retry.status).toBe(201);
      const [firstCall, retryCall] = createWithdrawal.mock.calls;
      // Must be v4-SHAPED even though it is derived: Ground rejects any other
      // version outright (`400 requestId must be a valid UUID v4`).
      expect(firstCall?.[1]?.requestId).toMatch(UUID_V4_PATTERN);
      // The whole point: the provider sees ONE withdrawal id across the crash,
      // so it replays rather than paying out twice.
      expect(retryCall?.[1]?.requestId).toBe(firstCall?.[1]?.requestId);
      // And the re-drive healed the row.
      const healed = await getDb(env)
        .prepare(
          "SELECT status, provider_reference FROM earn_program_withdrawals ORDER BY created_at DESC"
        )
        .first<{ status: string; provider_reference: string | null }>();
      expect(healed).toEqual({ status: "processing", provider_reference: "wd_test_1" });
    });

    it("keeps two different Idempotency-Keys apart", async () => {
      await seedAuth();
      await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      await requestEarn("POST", "/v1/earn/program/withdrawals", withdrawalBody(), {
        "Idempotency-Key": "payout-a",
      });
      await requestEarn("POST", "/v1/earn/program/withdrawals", withdrawalBody(), {
        "Idempotency-Key": "payout-b",
      });

      const [a, b] = createWithdrawal.mock.calls;
      expect(a?.[1]?.requestId).not.toBe(b?.[1]?.requestId);
    });

    it("refuses a withdrawal carrying both key sources", async () => {
      await seedAuth();
      await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      // The trap this guards: a retry layer that preserves headers while the
      // request layer mints a fresh body id per attempt keeps Idempotency-Key
      // stable and varies requestId. Any precedence rule would follow the
      // varying one and book a SECOND withdrawal, so refuse the ambiguity.
      const res = await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        withdrawalBody({ requestId: "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d" }),
        { "Idempotency-Key": "checkout-9f2b" }
      );

      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });

    it("refuses a withdrawal carrying no idempotency key at all", async () => {
      await seedAuth();
      await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const res = await requestEarn("POST", "/v1/earn/program/withdrawals", withdrawalBody());

      // Refusing beats accepting: a server-minted random id is fresh per
      // attempt, so it would turn a retry into a second payout.
      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });
  });

  it("rejects destinations that are not base58 Solana addresses", async () => {
    await seedAuth();
    await seedProgramWallet();
    const createWithdrawal = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal");

    const res = await requestEarn("POST", "/v1/earn/program/withdrawals", {
      provider: "ground",
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("base58 Solana address");
    expect(createWithdrawal).not.toHaveBeenCalled();
  });
});

describe("Earn program — withdrawal ledger (PRO-1628)", () => {
  const LEDGER_KEY = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

  const createBody = (extra: Record<string, unknown> = {}) => ({
    provider: "ground",
    requestId: LEDGER_KEY,
    amountUsd: "10.00",
    token: "usdc",
    destinationAddress: SOLANA_DESTINATION,
    ...extra,
  });

  async function readLedgerRows(): Promise<Array<Record<string, unknown>>> {
    const { results } = await getDb(env)
      .prepare("SELECT * FROM earn_program_withdrawals ORDER BY created_at DESC, id DESC")
      .all<Record<string, unknown>>();
    return results ?? [];
  }

  it("persists an intent row and advances it on provider acceptance", async () => {
    await seedAuth();
    await seedProgramWallet();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
      WITHDRAWAL
    );

    const res = await requestEarn("POST", "/v1/earn/program/withdrawals", createBody());
    expect(res.status).toBe(201);

    const [row] = await readLedgerRows();
    expect(row?.id).toMatch(/^earn_program_withdrawal_/);
    expect(row?.status).toBe("processing");
    expect(row?.provider).toBe("ground");
    expect(row?.provider_reference).toBe(WITHDRAWAL.withdrawalRef);
    expect(row?.amount_requested_usd).toBe("10.00");
    expect(row?.destination_address).toBe(SOLANA_DESTINATION);
    // The anchor is the DERIVED id, never the caller's raw key.
    expect(row?.request_id).toBe(
      deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], LEDGER_KEY)
    );
    expect(row?.idempotency_fingerprint).toBeTruthy();
    expect(row?.provider_data).toMatchObject({ lastObservation: { status: "processing" } });
    // Money-out forensics: who and which key pulled the money.
    expect(row?.created_by).toBe(TEST_USER.id);
    expect(row?.initiated_by_key_id).toBe(TEST_API_KEY.id);
  });

  it("refuses the same key with a different payload before any provider call", async () => {
    await seedAuth();
    await seedProgramWallet();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn("POST", "/v1/earn/program/withdrawals", createBody());
    expect(first.status).toBe(201);

    // An idempotency key names ONE intent; changing the payload under it is a
    // conflict — answered by SDP without touching the provider.
    const conflicting = await requestEarn(
      "POST",
      "/v1/earn/program/withdrawals",
      createBody({ amountUsd: "11.00" })
    );

    expect(conflicting.status).toBe(409);
    const body = (await conflicting.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
    await expect(readLedgerRows()).resolves.toHaveLength(1);
  });

  it("treats decimal-equivalent amounts as one request — never stricter than the provider", async () => {
    await seedAuth();
    await seedProgramWallet();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn(
      "POST",
      "/v1/earn/program/withdrawals",
      createBody({ amountUsd: "10.00" })
    );
    // The provider wire sends amountUsd as a JSON number, so '10' IS '10.00'
    // to Ground — SDP's fingerprint must replay it, not 409 it.
    const retry = await requestEarn(
      "POST",
      "/v1/earn/program/withdrawals",
      createBody({ amountUsd: "10" })
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("persists provider observations from the withdrawal detail poll", async () => {
    await seedAuth();
    await seedProgramWallet();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
      WITHDRAWAL
    );
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      status: "completed",
      amountPaidUsd: "9.90",
      feeUsd: "0.10",
      completedAt: "2026-08-11T05:00:00.000Z",
    });

    await requestEarn("POST", "/v1/earn/program/withdrawals", createBody());
    const res = await requestEarn(
      "GET",
      `/v1/earn/program/withdrawals/${WITHDRAWAL.withdrawalRef}?provider=ground`
    );

    expect(res.status).toBe(200);
    const [row] = await readLedgerRows();
    expect(row?.status).toBe("completed");
    expect(row?.amount_paid_usd).toBe("9.90");
    expect(row?.fee_usd).toBe("0.10");
    expect(row?.completed_at).toBe("2026-08-11T05:00:00.000Z");
  });

  it("serves live state for a pre-ledger withdrawal without inventing a row", async () => {
    await seedAuth();
    await seedProgramWallet();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      withdrawalRef: "wd_pre_ledger",
    });

    const res = await requestEarn(
      "GET",
      "/v1/earn/program/withdrawals/wd_pre_ledger?provider=ground"
    );

    expect(res.status).toBe(200);
    await expect(readLedgerRows()).resolves.toHaveLength(0);
  });

  it("404s a foreign organization's withdrawal ref BEFORE any provider call (BOLA guard)", async () => {
    await seedAuth();
    await seedProgramWallet();
    const getWithdrawal = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal");

    // A sibling organization with its own program and a ledger-known
    // withdrawal ref — the shared provider account is exactly why the ledger,
    // not the provider, must own cross-tenant scoping.
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
        )
        .bind("org_earn_program_victim", "Victim Org", "earn-program-victim"),
      db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Victim Project', ?, 'sandbox', 'active', ?)`
        )
        .bind("prj_earn_program_victim", "org_earn_program_victim", "victim-project", TEST_USER.id),
    ]);
    const repo = createPostgresEarnRepository(db);
    const victimWallet = await repo.insertProviderWallet({
      organizationId: "org_earn_program_victim",
      projectId: "prj_earn_program_victim",
      environment: "sandbox",
      provider: "ground",
      providerWalletRef: "9a35f56f-deeb-578f-0c7c-4d2b6d8f0e32",
      label: null,
      createdBy: TEST_USER.id,
    });
    const victimRow = await repo.createProgramWithdrawal({
      organizationId: "org_earn_program_victim",
      projectId: "prj_earn_program_victim",
      walletId: victimWallet?.id ?? "",
      provider: "ground",
      amountRequestedUsd: "50.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
      requestId: crypto.randomUUID(),
      idempotencyFingerprint: '{"scope":"earn_program_withdrawal"}',
      providerData: {},
      createdBy: TEST_USER.id,
      initiatedByKeyId: null,
    });
    await repo.updateProgramWithdrawalStatusGuarded({
      selector: { withdrawalId: victimRow?.id ?? "" },
      organizationId: "org_earn_program_victim",
      fromStatuses: ["requested"],
      toStatus: "processing",
      providerReference: "wd_victim_org",
    });

    const res = await requestEarn(
      "GET",
      "/v1/earn/program/withdrawals/wd_victim_org?provider=ground"
    );

    expect(res.status).toBe(404);
    expect(getWithdrawal).not.toHaveBeenCalled();
  });

  describe("GET /program/withdrawals — the ledger list", () => {
    it("returns the house list envelope from the ledger, newest first", async () => {
      await seedAuth();
      await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_a" })
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_b", status: "completed" });
      await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        createBody({ requestId: crypto.randomUUID(), amountUsd: "10.00" })
      );
      await requestEarn(
        "POST",
        "/v1/earn/program/withdrawals",
        createBody({ requestId: crypto.randomUUID(), amountUsd: "20.00" })
      );

      const res = await requestEarn("GET", "/v1/earn/program/withdrawals?provider=ground");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          withdrawals: Array<Record<string, unknown>>;
          total: number;
          page: number;
          pageSize: number;
        };
      };
      expect(body.data.total).toBe(2);
      expect(body.data.page).toBe(1);
      expect(body.data.pageSize).toBe(20);
      expect(body.data.withdrawals.map((w) => w.withdrawalRef).sort()).toEqual(["wd_a", "wd_b"]);
      const [record] = body.data.withdrawals;
      expect(record?.id).toMatch(/^earn_program_withdrawal_/);
      expect(record?.provider).toBe("ground");
      expect(record?.destinationAddress).toBe(SOLANA_DESTINATION);
      // Ledger records never leak the derivation internals.
      expect(record).not.toHaveProperty("requestId");
      expect(record).not.toHaveProperty("idempotencyFingerprint");

      // Pagination is DB-windowed, not in-memory: a 1-per-page second page
      // still reports the full total and exactly one row.
      const page2 = await requestEarn(
        "GET",
        "/v1/earn/program/withdrawals?provider=ground&page=2&pageSize=1"
      );
      expect(page2.status).toBe(200);
      const page2Body = (await page2.json()) as {
        data: {
          withdrawals: Array<Record<string, unknown>>;
          total: number;
          page: number;
          pageSize: number;
        };
      };
      expect(page2Body.data).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(page2Body.data.withdrawals).toHaveLength(1);
    });

    it("serves the audit trail even with provider credentials absent (exit-safety-adjacent)", async () => {
      await seedAuth();
      await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
        WITHDRAWAL
      );
      await requestEarn("POST", "/v1/earn/program/withdrawals", createBody());

      // Pull the provider's credentials entirely: live reads break…
      env.GROUND_SANDBOX_API_KEY = undefined;
      const live = await requestEarn("GET", "/v1/earn/program?provider=ground");
      expect(live.status).toBe(503);

      // …but the ledger keeps answering. History must outlive credentials.
      const list = await requestEarn("GET", "/v1/earn/program/withdrawals?provider=ground");
      expect(list.status).toBe(200);
      const body = (await list.json()) as { data: { total: number } };
      expect(body.data.total).toBe(1);
    });

    it("returns 404 while no program wallet exists", async () => {
      await seedAuth();

      const res = await requestEarn("GET", "/v1/earn/program/withdrawals?provider=ground");

      expect(res.status).toBe(404);
    });

    it("never serves the sandbox ledger to a production-project session", async () => {
      await seedAuth();
      await seedSessionAuth();
      await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
        WITHDRAWAL
      );
      await requestEarn("POST", "/v1/earn/program/withdrawals", createBody());

      // The production project has no program wallet, so the wallet-scoped
      // ledger is structurally unreachable from that environment.
      const res = await requestEarnAsSession(
        "GET",
        "/v1/earn/program/withdrawals?provider=ground",
        TEST_PRODUCTION_PROJECT.id
      );

      expect(res.status).toBe(404);
    });
  });
});
