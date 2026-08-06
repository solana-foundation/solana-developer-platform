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
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GROUND_SANDBOX_KEY = "ground-sandbox-test-api-key";
const GROUND_SOURCE = "morpho-gauntlet-usdc";
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

function requestEarn(method: string, path: string, body?: Record<string, unknown>) {
  return app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
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
  // Earn is a Markets sub-module, so both gates have to be on to reach a route.
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  // Sandbox credentials so the provider-configured gates pass; provider HTTP
  // itself is stubbed per-test via EARN_PROVIDER_CLIENTS spies.
  env.GROUND_SANDBOX_API_KEY = GROUND_SANDBOX_KEY;
  await seedTestDatabase(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.GROUND_SANDBOX_API_KEY = originalGroundSandboxApiKey;
  await clearTestDatabase(env);
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

  it("rejects allocation groups whose weights do not sum to 100", async () => {
    await seedAuth();
    await seedGroundStrategy();

    const res = await requestEarn("PUT", "/v1/earn/program", {
      provider: "ground",
      allocations: {
        usdc: [
          { yieldSourceId: GROUND_SOURCE, pct: 60 },
          { yieldSourceId: "morpho-steakhouse-usdc", pct: 30 },
        ],
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("sum to exactly 100");
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
    await clearTestDatabase(env);
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

  it("mints a UUIDv4 requestId when absent and passes a caller-owned key verbatim", async () => {
    await seedAuth();
    await seedProgramWallet();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const minted = await requestEarn("POST", "/v1/earn/program/withdrawals", {
      provider: "ground",
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
    });
    expect(minted.status).toBe(201);
    expect(createWithdrawal.mock.calls[0]?.[1]?.requestId).toMatch(UUID_V4_PATTERN);

    const callerKey = "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d";
    const verbatim = await requestEarn("POST", "/v1/earn/program/withdrawals", {
      provider: "ground",
      requestId: callerKey,
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
    });
    expect(verbatim.status).toBe(201);
    expect(createWithdrawal.mock.calls[1]?.[1]?.requestId).toBe(callerKey);
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
