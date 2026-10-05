import assert from "node:assert/strict";
import type { EarnPortfolioWalletProvider } from "@sdp/earn";
import { hashString } from "@sdp/payments/hash";
import type {
  CachedApiKey,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWithdrawal,
} from "@sdp/types";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { required } from "@/test/helpers/required";

const surfacing = vi.hoisted(() => ({ forceOn: true }));

vi.mock("@sdp/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/types")>();
  return {
    ...actual,
    isEarnProviderSurfaced: (provider: string) =>
      surfacing.forceOn || actual.isEarnProviderSurfaced(provider),
  };
});

const portfolioClient = vi.hoisted(
  () =>
    ({
      provider: "upshift",
      declaredSupport: { sourceKinds: ["defi", "rwa"], depositTokens: ["USDC"] },

      listStrategies: async () => [],
      createPortfolioWallet: async () => {},
      getPortfolioWallet: async () => {},
      updatePortfolioStrategy: async () => {},
      getPortfolioYield: async () => {},
      listPortfolioDeposits: async () => {},
      previewPortfolioWithdrawal: async () => {},
      createPortfolioWithdrawal: async () => {},
      getPortfolioWithdrawal: async () => {},
      createPortfolioAddressBookEntry: async () => {},
    }) as unknown as EarnPortfolioWalletProvider
);

vi.mock("@sdp/earn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/earn")>();
  return {
    ...actual,
    EARN_PROVIDER_CLIENTS: {
      ...actual.EARN_PROVIDER_CLIENTS,
      upshift: portfolioClient,
    },
  };
});

import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  createPostgresPolicyRepository,
  type EarnProviderWalletRow,
  type InsertEarnProviderWalletInput,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { createTenantScope } from "@/lib/tenant-scope";
import { AuditService } from "@/services/audit.service";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_PRODUCTION_API_KEY } from "@/test/fixtures/api-keys";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey, seedRateLimit } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_test_earn_program",
  name: "Earn Program Org",
  slug: "earn-program",
};
const TEST_PROJECT = {
  id: "prj_test_earn_program",
  slug: "test-earn-program-project",
};
const TEST_USER = {
  id: "usr_test_earn_program",
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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UPSHIFT_SANDBOX_KEY = "upshift-sandbox-test-api-key";
const UPSHIFT_PRODUCTION_KEY = "upshift-production-test-api-key";
const UPSHIFT_SOURCE = "morpho-gauntlet-usdc";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const UPSHIFT_USDT_SOURCE = "morpho-gauntlet-usdt";
const WALLET_REF = "8f14e45f-ceea-467f-9b6b-3c1a5c7f9d21";

const WALLET_REF_B = "2b6e1f80-7a3c-4f0d-9b21-5c8d4e2f1a03";
const SOLANA_DESTINATION = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_ALLOCATIONS = { usdc: [{ yieldSourceId: UPSHIFT_SOURCE, pct: 100 }] };

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
      yieldSourceId: UPSHIFT_SOURCE,
      token: "usdc",
    },
  ],
  allocations: { usdc: [{ yieldSourceId: UPSHIFT_SOURCE, weightBps: 10_000 }] },
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
let originalUpshiftSandboxApiKey: string | undefined;
let originalUpshiftApiKey: string | undefined;

async function seedAuth({ entitleGround }: { entitleGround: boolean }): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  const settings = entitleGround
    ? JSON.stringify({ providerOverrides: { earn: { upshift: true } } })
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
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
  });
  const productionKeyHash = await seedProjectApiKey(getDb(env), env, {
    key: TEST_PRODUCTION_API_KEY,
    organizationId: TEST_ORG.id,
    projectId: TEST_PRODUCTION_PROJECT.id,
    createdBy: TEST_USER.id,
    role: "api_admin",
    permissions: ["*"],
  });
  await seedCachedApiKey(env, productionKeyHash, {
    ...TEST_CACHED_API_KEY,
    id: TEST_PRODUCTION_API_KEY.id,
    projectId: TEST_PRODUCTION_PROJECT.id,
    environment: "production",
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
        "Earn Program Test Key",
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
      .bind("om_earn_program_Clerk", TEST_ORG.id, TEST_USER.id),
  ]);
}

async function seedUpshiftStrategy(
  overrides: Partial<UpsertEarnStrategyInput> & { environment: "sandbox" | "production" }
): Promise<void> {
  const environment = overrides.environment;
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "upshift",
    providerReference: UPSHIFT_SOURCE,
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

    hostCluster: CLUSTER_BY_SDP_ENVIRONMENT[environment],
    ...overrides,
  });
  assert(strategy);
}

async function seedProgramWallet(
  overrides: Partial<InsertEarnProviderWalletInput>
): Promise<EarnProviderWalletRow> {
  const row = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "upshift",
    providerWalletRef: WALLET_REF,
    label: "Test Program",
    createdBy: TEST_USER.id,
    ...overrides,
  });
  assert(row);
  return row;
}

function requestEarn(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string>
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

async function requestEarnAsClerk(
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
        Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
        "x-project-id": projectId,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    env
  );
}

const PROGRAMS_PATH = "/v1/earn/programs";
const programPath = (programId: string, suffix: string) => `${PROGRAMS_PATH}/${programId}${suffix}`;

const createProgramBody = (extra: Record<string, unknown>) => ({
  provider: "upshift",
  allocations: VALID_ALLOCATIONS,
  ...extra,
});

const derivedCreateId = (callerKey: string, environment: string) =>
  deriveProviderRequestId(["earn_program_create", TEST_ORG.id, environment, "upshift"], callerKey);

interface ProgramEnvelope {
  id: string;
  provider: string;
  label: string | null;
  createdAt: string;
  wallet: EarnPortfolioWalletSnapshot;
}

async function readProgram(res: Response): Promise<ProgramEnvelope> {
  const body = (await res.json()) as { data: { program: ProgramEnvelope } };
  return body.data.program;
}

async function readPrograms(res: Response): Promise<{
  programs: ProgramEnvelope[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const body = (await res.json()) as {
    data: { programs: ProgramEnvelope[]; total: number; page: number; pageSize: number };
  };
  return body.data;
}

function stubProgramReads() {
  vi.spyOn(portfolioClient, "getPortfolioYield").mockRejectedValue(
    new Error("yield unavailable in tests")
  );
  return vi
    .spyOn(portfolioClient, "getPortfolioWallet")
    .mockImplementation(async (_ctx, { providerWalletRef }) => ({
      ...WALLET_SNAPSHOT,
      providerWalletRef,
    }));
}

function stubProviderWalletDedupe() {
  const minted = new Map<string, string>();
  return vi
    .spyOn(portfolioClient, "createPortfolioWallet")
    .mockImplementation(async (_ctx, input) => {
      const existing = minted.get(input.requestId);
      if (existing) {
        return { providerWalletRef: existing, status: "creating" };
      }
      const ref = `0000000${minted.size + 1}-0000-4000-8000-000000000000`;
      minted.set(input.requestId, ref);
      return { providerWalletRef: ref, status: "creating" };
    });
}

async function countProviderWallets(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS total FROM earn_provider_wallets")
    .first<{ total: number }>();
  return required(row).total;
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalUpshiftSandboxApiKey = env.UPSHIFT_SANDBOX_API_KEY;
  originalUpshiftApiKey = env.UPSHIFT_API_KEY;

  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";

  env.UPSHIFT_SANDBOX_API_KEY = UPSHIFT_SANDBOX_KEY;
  env.UPSHIFT_API_KEY = undefined;
  surfacing.forceOn = true;
  await seedTestDatabase(env);
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.UPSHIFT_SANDBOX_API_KEY = originalUpshiftSandboxApiKey;
  env.UPSHIFT_API_KEY = originalUpshiftApiKey;
  await clearKVStores(env);
});

describe("Earn program — POST /programs (create) and PUT /programs/:id (re-target)", () => {
  it("creates a program, then re-targets that program in place", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi
      .spyOn(portfolioClient, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(portfolioClient, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    const callerKey = crypto.randomUUID();
    const created = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ label: "Treasury", requestId: callerKey }),
      {}
    );

    expect(created.status).toBe(201);
    const createdBody = (await created.clone().json()) as { data: Record<string, unknown> };

    expect(createdBody.data).not.toHaveProperty("created");
    const program = await readProgram(created);
    expect(program.id).toMatch(/^earn_provider_wallet_/);
    expect(program.provider).toBe("upshift");
    expect(program.label).toBe("Treasury");
    expect(program.wallet).toEqual(WALLET_SNAPSHOT);
    expect(createWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      label: "Treasury",
      allocations: VALID_ALLOCATIONS,
      requestId: derivedCreateId(callerKey, "sandbox"),
    });
    expect(updateStrategy).not.toHaveBeenCalled();

    const row = await createPostgresEarnRepository(getDb(env)).getProviderWalletById({
      organizationId: TEST_ORG.id,
      environment: "sandbox",
      walletId: program.id,
    });
    expect(required(row).provider_wallet_ref).toBe(WALLET_REF);

    const retargeted = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      {
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );

    expect(retargeted.status).toBe(200);
    expect((await readProgram(retargeted)).id).toBe(program.id);
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(updateStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      { providerWalletRef: WALLET_REF, allocations: VALID_ALLOCATIONS }
    );
  });

  it("derives the provider request id on both branches — never forwards the caller's raw key", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi
      .spyOn(portfolioClient, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(portfolioClient, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    const createRequestId = "3f1d5a2e-9b64-4c7f-8a10-2d5e6f7a8b90";
    const retargetRequestId = "5c2e7b41-8d36-4a92-bf05-1e4c9a7d3b28";

    const created = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: createRequestId }),
      {}
    );
    expect(created.status).toBe(201);
    const program = await readProgram(created);
    const sentOnCreate = required(required(createWallet.mock.calls[0])[1]).requestId;
    expect(sentOnCreate).toBe(derivedCreateId(createRequestId, "sandbox"));
    expect(sentOnCreate).not.toBe(createRequestId);
    expect(sentOnCreate).toMatch(UUID_V4_PATTERN);

    const retargeted = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      {
        allocations: VALID_ALLOCATIONS,
        requestId: retargetRequestId,
      },
      {}
    );
    expect(retargeted.status).toBe(200);
    const sentOnRetarget = required(required(updateStrategy.mock.calls[0])[1]).requestId;

    expect(sentOnRetarget).toBe(
      deriveProviderRequestId(["earn_program_retarget", WALLET_REF], retargetRequestId)
    );
    expect(sentOnRetarget).not.toBe(retargetRequestId);
  });

  it("honors an Idempotency-Key header on re-target exactly like its siblings", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const program = await seedProgramWallet({});
    const updateStrategy = vi
      .spyOn(portfolioClient, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    const headerKey = "retarget-9f2b";
    const retargeted = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      { allocations: VALID_ALLOCATIONS },
      { "Idempotency-Key": headerKey }
    );
    expect(retargeted.status).toBe(200);
    expect(required(required(updateStrategy.mock.calls[0])[1]).requestId).toBe(
      deriveProviderRequestId(["earn_program_retarget", program.provider_wallet_ref], headerKey)
    );

    const both = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      { allocations: VALID_ALLOCATIONS, requestId: crypto.randomUUID() },
      { "Idempotency-Key": headerKey }
    );
    expect(both.status).toBe(400);
    expect(updateStrategy).toHaveBeenCalledTimes(1);
  });

  it("refuses re-target when the organization is not entitled or credentials are missing", async () => {
    await seedAuth({ entitleGround: false });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const program = await seedProgramWallet({});
    const updateStrategy = vi.spyOn(portfolioClient, "updatePortfolioStrategy");

    const unentitled = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      {
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );
    expect(unentitled.status).toBe(403);

    await clearKVStores(env);
    await seedTestDatabase(env);
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const reseeded = await seedProgramWallet({});
    env.UPSHIFT_SANDBOX_API_KEY = undefined;

    const noCredentials = await requestEarn(
      "PUT",
      programPath(reseeded.id, ""),
      {
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );
    expect(noCredentials.status).toBe(403);
    expect(updateStrategy).not.toHaveBeenCalled();
  });

  it("rejects a requestId that is not a UUIDv4", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: "not-a-uuid" }),
      {}
    );

    expect(res.status).toBe(400);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects allocations referencing yield sources outside the synced catalogue", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: { usdc: [{ yieldSourceId: "morpho-unknown-usdc", pct: 100 }] },
        requestId: crypto.randomUUID(),
      }),
      {}
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { unknownYieldSourceIds?: string[] } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(required(body.error.details).unknownYieldSourceIds).toEqual(["morpho-unknown-usdc"]);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects more than one allocation entry per token group (V1 single-vault cap)", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: {
          usdc: [
            { yieldSourceId: UPSHIFT_SOURCE, pct: 50 },
            { yieldSourceId: "morpho-steakhouse-usdc", pct: 50 },
          ],
        },
        requestId: crypto.randomUUID(),
      }),
      {}
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("exactly one allocation entry per token group");
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects a lone allocation entry whose weight is not 100", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: { usdc: [{ yieldSourceId: UPSHIFT_SOURCE, pct: 60 }] },
        requestId: crypto.randomUUID(),
      }),
      {}
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("sum to exactly 100");
  });

  it("accepts one entry per token group across both deposit tokens", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    await seedUpshiftStrategy({
      environment: "sandbox",
      providerReference: UPSHIFT_USDT_SOURCE,
      name: "Gauntlet USDT",
      depositMints: [USDT_MINT],
    });
    const createWallet = vi
      .spyOn(portfolioClient, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    stubProgramReads();

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: {
          usdc: [{ yieldSourceId: UPSHIFT_SOURCE, pct: 100 }],
          usdt: [{ yieldSourceId: UPSHIFT_USDT_SOURCE, pct: 100 }],
        },
        requestId: crypto.randomUUID(),
      }),
      {}
    );

    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalledTimes(1);
  });

  it("blocks create when the organization is not entitled or credentials are missing", async () => {
    await seedAuth({ entitleGround: false });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const unentitled = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() }),
      {}
    );
    expect(unentitled.status).toBe(403);

    await clearKVStores(env);
    await seedTestDatabase(env);
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    env.UPSHIFT_SANDBOX_API_KEY = undefined;

    const unconfigured = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() }),
      {}
    );
    expect(unconfigured.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("returns 501 for providers without the portfolio-wallet capability", async () => {
    await seedAuth({ entitleGround: true });

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      {
        provider: "veda",
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("returns 501 for a catalogue-only provider, whose vaults ARE in the catalogue", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({
      environment: "sandbox",
      provider: "kamino",
      hostCluster: "mainnet-beta",
    });

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      {
        provider: "kamino",
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("refuses an allocation whose strategy is hosted on another cluster", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox", hostCluster: "mainnet-beta" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() }),
      {}
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { unknownYieldSourceIds?: string[] } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(required(body.error.details).unknownYieldSourceIds).toEqual([UPSHIFT_SOURCE]);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("accepts the same allocation once the strategy is hosted on this cluster", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox", hostCluster: "devnet" });
    const createWallet = vi
      .spyOn(portfolioClient, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    stubProgramReads();

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() }),
      {}
    );

    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalled();
  });

  it("answers an unentitled create 403 even when no idempotency key was sent", async () => {
    await seedAuth({ entitleGround: false });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn("POST", PROGRAMS_PATH, createProgramBody({}), {});

    expect(res.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  describe("required idempotency key (PRO-1670)", () => {
    it("refuses both key sources and neither, and accepts the header alone", async () => {
      await seedAuth({ entitleGround: true });
      await seedUpshiftStrategy({ environment: "sandbox" });
      const createWallet = vi
        .spyOn(portfolioClient, "createPortfolioWallet")
        .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
      stubProgramReads();

      const both = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d" }),
        { "Idempotency-Key": "onboarding-9f2b" }
      );
      expect(both.status).toBe(400);

      const neither = await requestEarn("POST", PROGRAMS_PATH, createProgramBody({}), {});
      expect(neither.status).toBe(400);
      expect(createWallet).not.toHaveBeenCalled();

      const headerOnly = await requestEarn("POST", PROGRAMS_PATH, createProgramBody({}), {
        "Idempotency-Key": "onboarding-9f2b",
      });
      expect(headerOnly.status).toBe(201);
      expect(createWallet).toHaveBeenCalledTimes(1);
      expect(required(required(createWallet.mock.calls[0])[1]).requestId).toBe(
        derivedCreateId("onboarding-9f2b", "sandbox")
      );
    });

    it("provisions exactly ONE wallet when the same caller key is retried", async () => {
      await seedAuth({ entitleGround: true });
      await seedUpshiftStrategy({ environment: "sandbox" });
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const callerKey = crypto.randomUUID();
      const first = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: callerKey }),
        {}
      );
      const retry = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: callerKey }),
        {}
      );

      expect(first.status).toBe(201);

      expect(retry.status).toBe(200);
      expect((await readProgram(retry)).id).toBe((await readProgram(first)).id);

      expect(createWallet).toHaveBeenCalledTimes(2);
      expect(required(required(createWallet.mock.calls[1])[1]).requestId).toBe(
        required(required(createWallet.mock.calls[0])[1]).requestId
      );
      await expect(countProviderWallets()).resolves.toBe(1);
    });

    it("provisions exactly ONE wallet when the same caller key arrives concurrently", async () => {
      await seedAuth({ entitleGround: true });
      await seedUpshiftStrategy({ environment: "sandbox" });
      stubProviderWalletDedupe();
      stubProgramReads();

      const callerKey = crypto.randomUUID();
      const [a, b] = await Promise.all([
        requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: callerKey }), {}),
        requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: callerKey }), {}),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((await readProgram(a)).id).toBe((await readProgram(b)).id);
      await expect(countProviderWallets()).resolves.toBe(1);
    });

    it("provisions TWO wallets for two different caller keys", async () => {
      await seedAuth({ entitleGround: true });
      await seedUpshiftStrategy({ environment: "sandbox" });
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const first = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: crypto.randomUUID() }),
        {}
      );
      const second = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: crypto.randomUUID() }),
        {}
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const [programA, programB] = [await readProgram(first), await readProgram(second)];
      expect(programA.id).not.toBe(programB.id);
      expect(programA.wallet.providerWalletRef).not.toBe(programB.wallet.providerWalletRef);
      expect(required(required(createWallet.mock.calls[0])[1]).requestId).not.toBe(
        required(required(createWallet.mock.calls[1])[1]).requestId
      );
      await expect(countProviderWallets()).resolves.toBe(2);
    });

    it("gives each unlabelled program its own default provider label", async () => {
      await seedAuth({ entitleGround: true });
      await seedUpshiftStrategy({ environment: "sandbox" });
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const keyOne = crypto.randomUUID();
      const keyTwo = crypto.randomUUID();
      await requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: keyOne }), {});
      await requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: keyTwo }), {});

      const labelOne = required(required(createWallet.mock.calls[0])[1]).label;
      const labelTwo = required(required(createWallet.mock.calls[1])[1]).label;
      expect(labelOne).toBe(
        `sdp-earn-${TEST_ORG.id}-sandbox-${derivedCreateId(keyOne, "sandbox").slice(0, 8)}`
      );
      expect(labelTwo).toBe(
        `sdp-earn-${TEST_ORG.id}-sandbox-${derivedCreateId(keyTwo, "sandbox").slice(0, 8)}`
      );
      expect(labelOne).not.toBe(labelTwo);
    });
  });
});

describe("Earn programs — many per (organization, environment) (PRO-1670)", () => {
  async function seedTwoPrograms(): Promise<{
    a: EarnProviderWalletRow;
    b: EarnProviderWalletRow;
  }> {
    await seedAuth({ entitleGround: true });
    const a = await seedProgramWallet({ providerWalletRef: WALLET_REF, label: "Program A" });
    const b = await seedProgramWallet({ providerWalletRef: WALLET_REF_B, label: "Program B" });
    return { a, b };
  }

  const withdrawalBody = (extra: Record<string, unknown>) => ({
    amountUsd: "10.00",
    token: "usdc",
    destinationAddress: SOLANA_DESTINATION,
    ...extra,
  });

  it("lists both programs with distinct ids and each one's OWN live snapshot", async () => {
    const { a, b } = await seedTwoPrograms();
    const getWallet = stubProgramReads();

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=upshift`, undefined, {});

    expect(res.status).toBe(200);
    const page = await readPrograms(res);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(page.programs.map((program) => program.id).sort()).toEqual([a.id, b.id].sort());

    const byId = new Map(page.programs.map((program) => [program.id, program]));
    expect(required(byId.get(a.id)).wallet.providerWalletRef).toBe(WALLET_REF);
    expect(required(byId.get(a.id)).label).toBe("Program A");
    expect(required(byId.get(b.id)).wallet.providerWalletRef).toBe(WALLET_REF_B);
    expect(required(byId.get(b.id)).label).toBe("Program B");
    expect(getWallet).toHaveBeenCalledTimes(2);

    const paged = await requestEarn(
      "GET",
      `${PROGRAMS_PATH}?provider=upshift&page=2&pageSize=1`,
      undefined,
      {}
    );
    expect(paged.status).toBe(200);
    const pagedBody = await readPrograms(paged);
    expect(pagedBody).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(pagedBody.programs).toHaveLength(1);
  });

  it("serves each program id its own wallet, never its sibling's", async () => {
    const { a, b } = await seedTwoPrograms();
    const getWallet = stubProgramReads();

    const detailA = await requestEarn("GET", programPath(a.id, ""), undefined, {});
    const detailB = await requestEarn("GET", programPath(b.id, ""), undefined, {});

    expect(detailA.status).toBe(200);
    expect(detailB.status).toBe(200);
    expect((await readProgram(detailA)).wallet.providerWalletRef).toBe(WALLET_REF);
    expect((await readProgram(detailB)).wallet.providerWalletRef).toBe(WALLET_REF_B);
    expect(getWallet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ environment: "sandbox" }),
      { providerWalletRef: WALLET_REF }
    );
    expect(getWallet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ environment: "sandbox" }),
      { providerWalletRef: WALLET_REF_B }
    );
  });

  it("routes each program's withdrawal to its own wallet and keeps the ledgers apart", async () => {
    const { a, b } = await seedTwoPrograms();
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockImplementation(async (_ctx, input) => ({
        ...WITHDRAWAL,
        withdrawalRef: input.providerWalletRef === WALLET_REF ? "wd_a" : "wd_b",
      }));

    const createdA = await requestEarn(
      "POST",
      programPath(a.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() }),
      {}
    );
    const createdB = await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() }),
      {}
    );

    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    expect(required(required(createWithdrawal.mock.calls[0])[1]).providerWalletRef).toBe(
      WALLET_REF
    );
    expect(required(required(createWithdrawal.mock.calls[1])[1]).providerWalletRef).toBe(
      WALLET_REF_B
    );

    const listA = await requestEarn("GET", programPath(a.id, "/withdrawals"), undefined, {});
    expect(listA.status).toBe(200);
    const bodyA = (await listA.json()) as {
      data: { withdrawals: Array<{ withdrawalRef?: string }>; total: number };
    };
    expect(bodyA.data.total).toBe(1);
    expect(bodyA.data.withdrawals.map((w) => w.withdrawalRef)).toEqual(["wd_a"]);
    expect(bodyA.data.withdrawals.map((w) => w.withdrawalRef)).not.toContain("wd_b");

    const listB = await requestEarn("GET", programPath(b.id, "/withdrawals"), undefined, {});
    const bodyB = (await listB.json()) as {
      data: { withdrawals: Array<{ withdrawalRef?: string }>; total: number };
    };
    expect(bodyB.data.total).toBe(1);
    expect(bodyB.data.withdrawals.map((w) => w.withdrawalRef)).toEqual(["wd_b"]);
  });

  it("derives two DISTINCT provider request ids from one caller key across two programs", async () => {
    const { a, b } = await seedTwoPrograms();
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockImplementation(async (_ctx, input) => ({
        ...WITHDRAWAL,
        withdrawalRef: input.providerWalletRef === WALLET_REF ? "wd_a" : "wd_b",
      }));

    const shared = "00000000-0000-4000-8000-000000000000";
    const fromA = await requestEarn(
      "POST",
      programPath(a.id, "/withdrawals"),
      withdrawalBody({ requestId: shared }),
      {}
    );
    const fromB = await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: shared }),
      {}
    );

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    const sentA = required(required(createWithdrawal.mock.calls[0])[1]).requestId;
    const sentB = required(required(createWithdrawal.mock.calls[1])[1]).requestId;
    expect(sentA).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], shared));
    expect(sentB).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF_B], shared));
    expect(sentA).not.toBe(sentB);

    const count = await getDb(env)
      .prepare(
        "SELECT COUNT(*)::int AS total FROM earn_movements WHERE execution_model = 'custodial'"
      )
      .first<{ total: number }>();
    expect(required(count).total).toBe(2);
  });

  it("404s program A's request for program B's withdrawal ref (intra-org BOLA guard)", async () => {
    const { a, b } = await seedTwoPrograms();
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      withdrawalRef: "wd_b",
    });
    await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() }),
      {}
    );
    const getWithdrawal = vi
      .spyOn(portfolioClient, "getPortfolioWithdrawal")
      .mockResolvedValue({ ...WITHDRAWAL, withdrawalRef: "wd_b" });

    const crossRead = await requestEarn(
      "GET",
      programPath(a.id, "/withdrawals/wd_b"),
      undefined,
      {}
    );

    expect(crossRead.status).toBe(404);
    expect(getWithdrawal).not.toHaveBeenCalled();

    const ownRead = await requestEarn("GET", programPath(b.id, "/withdrawals/wd_b"), undefined, {});
    expect(ownRead.status).toBe(200);
    expect(getWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("404s another organization's program id", async () => {
    await seedAuth({ entitleGround: true });
    const getWallet = stubProgramReads();

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
        )
        .bind("org_test_earn_program_neighbour", "Neighbour Org", "earn-program-neighbour"),
    ]);
    await seedDefaultProjects(db, {
      organizationId: "org_test_earn_program_neighbour",
      createdBy: TEST_USER.id,
      members: [],
      ids: {
        sandbox: "prj_earn_program_neighbour",
        production: "prj_earn_program_neighbour_production",
      },
    });
    const foreign = await seedProgramWallet({
      organizationId: "org_test_earn_program_neighbour",
      projectId: "prj_earn_program_neighbour",
      providerWalletRef: "9a35f56f-deeb-478f-8c7c-4d2b6d8f0e32",
      label: null,
    });

    const res = await requestEarn("GET", programPath(foreign.id, ""), undefined, {});

    expect(res.status).toBe(404);
    expect(getWallet).not.toHaveBeenCalled();
  });
});

describe("Earn program — Clerk callers and environment isolation", () => {
  it("creates a production program from a production-project dashboard Clerk", async () => {
    await seedAuth({ entitleGround: true });
    await seedClerkAuth();
    env.UPSHIFT_API_KEY = UPSHIFT_PRODUCTION_KEY;
    await seedUpshiftStrategy({ environment: "production" });
    const createWallet = vi
      .spyOn(portfolioClient, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    stubProgramReads();

    const callerKey = crypto.randomUUID();
    const res = await requestEarnAsClerk(
      "POST",
      PROGRAMS_PATH,
      TEST_PRODUCTION_PROJECT.id,
      createProgramBody({ requestId: callerKey })
    );

    expect(res.status).toBe(201);
    const program = await readProgram(res);
    expect(createWallet).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "production" }),
      expect.objectContaining({
        allocations: VALID_ALLOCATIONS,

        requestId: derivedCreateId(callerKey, "production"),
      })
    );

    const repo = createPostgresEarnRepository(getDb(env));
    const productionRow = await repo.getProviderWalletById({
      organizationId: TEST_ORG.id,
      environment: "production",
      walletId: program.id,
    });
    expect(required(productionRow).provider_wallet_ref).toBe(WALLET_REF);
    expect(required(productionRow).environment).toBe("production");
    await expect(
      repo.listProviderWallets({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        environment: "sandbox",
        limit: 20,
        offset: 0,
      })
    ).resolves.toMatchObject({ rows: [], total: 0 });

    const sandboxList = await requestEarn(
      "GET",
      `${PROGRAMS_PATH}?provider=upshift`,
      undefined,
      {}
    );
    expect(sandboxList.status).toBe(200);
    expect(await readPrograms(sandboxList)).toMatchObject({ programs: [], total: 0 });

    const guessed = await requestEarn("GET", programPath(program.id, ""), undefined, {});
    expect(guessed.status).toBe(404);
  });

  it("never serves a sandbox program to a production-project Clerk", async () => {
    await seedAuth({ entitleGround: true });
    await seedClerkAuth();

    env.UPSHIFT_API_KEY = UPSHIFT_PRODUCTION_KEY;
    const program = await seedProgramWallet({});
    const getWallet = stubProgramReads();

    const productionList = await requestEarnAsClerk(
      "GET",
      `${PROGRAMS_PATH}?provider=upshift`,
      TEST_PRODUCTION_PROJECT.id
    );
    expect(productionList.status).toBe(200);
    expect(await readPrograms(productionList)).toMatchObject({ programs: [], total: 0 });

    const guessed = await requestEarnAsClerk(
      "GET",
      programPath(program.id, ""),
      TEST_PRODUCTION_PROJECT.id
    );
    expect(guessed.status).toBe(404);
    expect(getWallet).not.toHaveBeenCalled();

    const sandbox = await requestEarnAsClerk("GET", programPath(program.id, ""), TEST_PROJECT.id);
    expect(sandbox.status).toBe(200);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });
});

describe("Earn program — live reads", () => {
  it.each<[string, string, string, Record<string, unknown> | undefined]>([
    ["program", "GET", "", undefined],
    ["deposits", "GET", "/deposits", undefined],
    ["withdrawal preview", "POST", "/withdrawal-preview", { amountUsd: "25.50", token: "usdc" }],
  ])("404s another project's program on %s", async (_name, method, suffix, body) => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const response = await requestEarn(method, programPath(program.id, suffix), body, {
      Authorization: `Bearer ${TEST_PRODUCTION_API_KEY.raw}`,
    });
    expect(response.status).toBe(404);
  });

  it("returns an empty collection while the organization has no programs", async () => {
    await seedAuth({ entitleGround: true });

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=upshift`, undefined, {});

    expect(res.status).toBe(200);
    expect(await readPrograms(res)).toMatchObject({
      programs: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("runs the credential gate on an EMPTY collection", async () => {
    await seedAuth({ entitleGround: true });
    env.UPSHIFT_SANDBOX_API_KEY = undefined;

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=upshift`, undefined, {});

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("returns 404 for a program id that does not exist", async () => {
    await seedAuth({ entitleGround: true });

    const res = await requestEarn(
      "GET",
      programPath("earn_provider_wallet_missing", ""),
      undefined,
      {}
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("serves the live provider snapshot for an existing program", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const getWallet = stubProgramReads();

    const res = await requestEarn("GET", programPath(program.id, ""), undefined, {});

    expect(res.status).toBe(200);
    const body = await readProgram(res);
    expect(body.id).toBe(program.id);
    expect(body.provider).toBe("upshift");
    expect(body.label).toBe("Test Program");
    expect(body.wallet).toEqual(WALLET_SNAPSHOT);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });

  it("passes deposit pagination cursors through to the provider", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const listDeposits = vi.spyOn(portfolioClient, "listPortfolioDeposits").mockResolvedValue({
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
      programPath(program.id, "/deposits?cursor=cursor-1"),
      undefined,
      {}
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

describe("Earn program — un-surfaced provider", () => {
  beforeEach(() => {
    surfacing.forceOn = false;
  });

  it("refuses to open a new position, even for a fully entitled and credentialed org", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const createWallet = vi.spyOn(portfolioClient, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() }),
      {}
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };

    expect(body.error.message).toContain("not currently offered");
    expect(body.error.message).not.toContain("manual activation");

    expect(createWallet).not.toHaveBeenCalled();
  });

  it("keeps an existing program readable, re-targetable and withdrawable", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const program = await seedProgramWallet({});
    stubProgramReads();
    const updateStrategy = vi
      .spyOn(portfolioClient, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const read = await requestEarn("GET", programPath(program.id, ""), undefined, {});
    expect(read.status).toBe(200);

    const list = await requestEarn("GET", `${PROGRAMS_PATH}?provider=upshift`, undefined, {});
    expect(list.status).toBe(200);

    const retarget = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      {
        allocations: VALID_ALLOCATIONS,
      },
      {}
    );
    expect(retarget.status).toBe(200);
    expect(updateStrategy).toHaveBeenCalledTimes(1);

    const withdrawal = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      {
        requestId: "0a1f4c2e-9b6d-4e83-8a11-5c7d2e9f4b60",
        amountUsd: "25.50",
        token: "usdc",
        destinationAddress: SOLANA_DESTINATION,
      },
      {}
    );
    expect(withdrawal.status).toBe(201);
  });

  it("still validates re-target allocations against the stored catalogue", async () => {
    await seedAuth({ entitleGround: true });
    await seedUpshiftStrategy({ environment: "sandbox" });
    const program = await seedProgramWallet({});
    stubProgramReads();

    const res = await requestEarn(
      "PUT",
      programPath(program.id, ""),
      {
        allocations: [
          { token: "usdc", entries: [{ yieldSourceId: "not-in-catalogue", pct: 100 }] },
        ],
      },
      {}
    );

    expect(res.status).toBe(400);
  });
});

describe("Earn program — withdrawals (ADR 0002 exit safety)", () => {
  it("keeps withdrawals and previews working when the organization loses deposit entitlement", async () => {
    await seedAuth({ entitleGround: false });
    const program = await seedProgramWallet({});
    const preview = vi.spyOn(portfolioClient, "previewPortfolioWithdrawal").mockResolvedValue({
      amountRequestedUsd: "25.50",
      feeUsd: "0.10",
      withdrawableUsd: "90.00",
      totalUsdAfterWithdrawal: "74.40",
    });
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    vi.spyOn(portfolioClient, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const previewRes = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawal-preview"),
      {
        amountUsd: "25.50",
        token: "usdc",
      },
      {}
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { data: { preview: { feeUsd: string } } };
    expect(previewBody.data.preview.feeUsd).toBe("0.10");
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
      amountUsd: "25.50",
      token: "usdc",
    });

    const withdrawalRes = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      {
        requestId: "5b0e0c9a-7f3d-4a21-9c46-2f8ab1d5e740",
        amountUsd: "25.50",
        token: "usdc",
        destinationAddress: SOLANA_DESTINATION,
      },
      {}
    );
    expect(withdrawalRes.status).toBe(201);
    const withdrawalBody = (await withdrawalRes.json()) as {
      data: { withdrawal: { withdrawalRef: string; status: string } };
    };
    expect(withdrawalBody.data.withdrawal).toEqual(WITHDRAWAL);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);

    const statusRes = await requestEarn(
      "GET",
      programPath(program.id, `/withdrawals/${WITHDRAWAL.withdrawalRef}`),
      undefined,
      {}
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { data: { withdrawal: { status: string } } };
    expect(statusBody.data.withdrawal.status).toBe("processing");
  });

  describe("amount-less preview (the liquidity read)", () => {
    it("omits amountUsd from the provider call and answers with the lane ceiling", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const preview = vi.spyOn(portfolioClient, "previewPortfolioWithdrawal").mockResolvedValue({
        feeUsd: "0.10",
        withdrawableUsd: "412.50",
        totalUsdAfterWithdrawal: "412.50",
        processingEstimate: {
          basis: "banking_days",
          typicalMinDuration: "P1D",
          typicalMaxDuration: "P3D",
        },
      });

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawal-preview"),
        {
          token: "usdc",
        },
        {}
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { preview: { withdrawableUsd: string; amountRequestedUsd?: string } };
      };
      expect(body.data.preview.withdrawableUsd).toBe("412.50");

      expect(body.data.preview.amountRequestedUsd).toBeUndefined();

      const [, input] = required(preview.mock.calls[0]);
      expect(input).toEqual({ providerWalletRef: WALLET_REF, token: "usdc" });
      expect(input && "amountUsd" in input).toBe(false);
    });

    it("keeps amountUsd required on the payout path even though the preview made it optional", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi.spyOn(portfolioClient, "createPortfolioWithdrawal");

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        {
          requestId: "0b1f2c3d-4e5a-4b6c-8d9e-0f1a2b3c4d5e",
          token: "usdc",
          destinationAddress: SOLANA_DESTINATION,
        },
        {}
      );

      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });

    it("still 503s without credentials rather than inventing a liquidity figure", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const preview = vi.spyOn(portfolioClient, "previewPortfolioWithdrawal");
      env.UPSHIFT_SANDBOX_API_KEY = undefined;

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawal-preview"),
        {
          token: "usdc",
        },
        {}
      );

      expect(res.status).toBe(503);
      expect(preview).not.toHaveBeenCalled();
    });
  });

  describe("withdrawal idempotency", () => {
    const withdrawalBody = (extra: Record<string, unknown>) => ({
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
      ...extra,
    });

    it("resolves a caller-key retry from the ledger: one provider create, replay served live", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);
      const getWithdrawal = vi
        .spyOn(portfolioClient, "getPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const callerKey = "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d";
      const first = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: callerKey }),
        {}
      );
      const retry = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: callerKey }),
        {}
      );

      expect(first.status).toBe(201);

      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as { data: { withdrawal: { status: string } } };
      expect(retryBody.data.withdrawal.status).toBe("processing");
      expect(createWithdrawal).toHaveBeenCalledTimes(1);
      expect(getWithdrawal).toHaveBeenCalledTimes(1);
      const sent = required(required(createWithdrawal.mock.calls[0])[1]).requestId;
      expect(sent).not.toBe(callerKey);
      expect(sent).toMatch(UUID_V4_PATTERN);

      const count = await getDb(env)
        .prepare(
          "SELECT COUNT(*)::int AS total FROM earn_movements WHERE execution_model = 'custodial'"
        )
        .first<{ total: number }>();
      expect(required(count).total).toBe(1);
    });

    it("sends a key no other organization could produce from the same input", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const shared = "00000000-0000-4000-8000-000000000000";
      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: shared }),
        {}
      );

      expect(res.status).toBe(201);
      const sent = required(required(createWithdrawal.mock.calls[0])[1]).requestId;
      expect(sent).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], shared));

      expect(sent).not.toBe(
        deriveProviderRequestId(["earn_program_withdrawal", "another-org-wallet"], shared)
      );
    });

    it("re-drives a crash-window retry with the SAME derived key from one Idempotency-Key", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});

      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(WITHDRAWAL);

      const headers = { "Idempotency-Key": "checkout-9f2b" };
      const first = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({}),
        headers
      );
      expect(first.status).toBe(500);

      const stranded = await getDb(env)
        .prepare("SELECT status, provider_reference FROM earn_movements ORDER BY created_at DESC")
        .first<{ status: string; provider_reference: string | null }>();
      expect(stranded).toEqual({ status: "requested", provider_reference: null });

      const retry = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({}),
        headers
      );

      expect(retry.status).toBe(201);
      const [firstCall, retryCall] = createWithdrawal.mock.calls;

      expect(required(required(firstCall)[1]).requestId).toMatch(UUID_V4_PATTERN);

      expect(required(required(retryCall)[1]).requestId).toBe(
        required(required(firstCall)[1]).requestId
      );

      const healed = await getDb(env)
        .prepare("SELECT status, provider_reference FROM earn_movements ORDER BY created_at DESC")
        .first<{ status: string; provider_reference: string | null }>();
      expect(healed).toEqual({ status: "processing", provider_reference: "wd_test_1" });
    });

    it("keeps two different Idempotency-Keys apart", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      await requestEarn("POST", programPath(program.id, "/withdrawals"), withdrawalBody({}), {
        "Idempotency-Key": "payout-a",
      });
      await requestEarn("POST", programPath(program.id, "/withdrawals"), withdrawalBody({}), {
        "Idempotency-Key": "payout-b",
      });

      const [a, b] = createWithdrawal.mock.calls;
      expect(required(required(a)[1]).requestId).not.toBe(required(required(b)[1]).requestId);
    });

    it("refuses a withdrawal carrying both key sources", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d" }),
        { "Idempotency-Key": "checkout-9f2b" }
      );

      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });

    it("refuses a withdrawal carrying no idempotency key at all", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody({}),
        {}
      );

      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });
  });

  it("rejects destinations that are not base58 Solana addresses", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const createWithdrawal = vi.spyOn(portfolioClient, "createPortfolioWithdrawal");

    const res = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      {
        amountUsd: "10.00",
        token: "usdc",
        destinationAddress: "0x52908400098527886E0F7030069857D2E4169EE7",
      },
      {}
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(JSON.stringify(body)).toContain("base58 Solana address");
    expect(createWithdrawal).not.toHaveBeenCalled();
  });
});

describe("Earn program — withdrawal ledger (PRO-1628)", () => {
  const LEDGER_KEY = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

  const createBody = (extra: Record<string, unknown>) => ({
    requestId: LEDGER_KEY,
    amountUsd: "10.00",
    token: "usdc",
    destinationAddress: SOLANA_DESTINATION,
    ...extra,
  });

  async function readLedgerRows(): Promise<Array<Record<string, unknown>>> {
    const { results } = await getDb(env)
      .prepare(
        `SELECT movement.*, position.provider_wallet_id AS wallet_id
           FROM earn_movements movement
           INNER JOIN earn_positions position ON position.id = movement.position_id
          ORDER BY movement.created_at DESC, movement.id DESC`
      )
      .all<Record<string, unknown>>();
    return results;
  }

  it("persists an intent row and advances it on provider acceptance", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const res = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({}),
      {}
    );
    expect(res.status).toBe(201);

    const [row] = await readLedgerRows();

    expect(required(row).id).toMatch(/^earn_movement_/);
    expect(required(row).status).toBe("processing");
    expect(required(row).provider).toBe("upshift");
    expect(required(row).wallet_id).toBe(program.id);
    expect(required(row).provider_reference).toBe(WITHDRAWAL.withdrawalRef);
    expect(required(row).amount_requested).toBe("10.00");
    expect(required(row).destination_address).toBe(SOLANA_DESTINATION);

    expect(required(row).request_id).toBe(
      deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], LEDGER_KEY)
    );
    expect(required(row).idempotency_fingerprint).toBeTruthy();
    expect(required(row).provider_data).toMatchObject({
      lastObservation: { status: "processing" },
    });

    expect(required(row).created_by).toBe(TEST_USER.id);
    expect(required(row).initiated_by_key_id).toBe(TEST_API_KEY.id);
  });

  it("refuses the same key with a different payload before any provider call", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({}),
      {}
    );
    expect(first.status).toBe(201);

    const conflicting = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({ amountUsd: "11.00" }),
      {}
    );

    expect(conflicting.status).toBe(409);
    const body = (await conflicting.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
    await expect(readLedgerRows()).resolves.toHaveLength(1);
  });

  it("treats decimal-equivalent amounts as one request — never stricter than the provider", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    vi.spyOn(portfolioClient, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({ amountUsd: "10.00" }),
      {}
    );

    const retry = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({ amountUsd: "10" }),
      {}
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("persists provider observations from the withdrawal detail poll", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);
    vi.spyOn(portfolioClient, "getPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      status: "completed",
      amountPaidUsd: "9.90",
      feeUsd: "0.10",
      completedAt: "2026-08-11T05:00:00.000Z",
    });

    await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody({}), {});
    const res = await requestEarn(
      "GET",
      programPath(program.id, `/withdrawals/${WITHDRAWAL.withdrawalRef}`),
      undefined,
      {}
    );

    expect(res.status).toBe(200);
    const [row] = await readLedgerRows();
    expect(required(row).status).toBe("completed");
    expect(required(row).amount_settled).toBe("9.90");
    expect(required(row).fee_amount).toBe("0.10");
    expect(required(row).settled_at).toBe("2026-08-11T05:00:00.000Z");
  });

  it("serves live state for a pre-ledger withdrawal without inventing a row", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    vi.spyOn(portfolioClient, "getPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      withdrawalRef: "wd_pre_ledger",
    });

    const res = await requestEarn(
      "GET",
      programPath(program.id, "/withdrawals/wd_pre_ledger"),
      undefined,
      {}
    );

    expect(res.status).toBe(200);
    await expect(readLedgerRows()).resolves.toHaveLength(0);
  });

  it("404s a foreign organization's withdrawal ref BEFORE any provider call (BOLA guard)", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const getWithdrawal = vi.spyOn(portfolioClient, "getPortfolioWithdrawal");

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
        )
        .bind("org_test_earn_program_victim", "Victim Org", "earn-program-victim"),
    ]);
    await seedDefaultProjects(db, {
      organizationId: "org_test_earn_program_victim",
      createdBy: TEST_USER.id,
      members: [],
      ids: {
        sandbox: "prj_earn_program_victim",
        production: "prj_earn_program_victim_production",
      },
    });
    const repo = createPostgresEarnRepository(db);
    const victimWallet = await repo.insertProviderWallet({
      organizationId: "org_test_earn_program_victim",
      projectId: "prj_earn_program_victim",
      environment: "sandbox",
      provider: "upshift",
      providerWalletRef: "9a35f56f-deeb-478f-8c7c-4d2b6d8f0e32",
      label: null,
      createdBy: TEST_USER.id,
    });
    const victimRow = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).createCustodialMovement({
      organizationId: "org_test_earn_program_victim",
      projectId: "prj_earn_program_victim",
      environment: "sandbox",
      providerWalletId: required(victimWallet).id,
      provider: "upshift",
      amountRequestedUsd: "50.00",
      payoutToken: "usdc",
      destinationAddress: SOLANA_DESTINATION,
      requestId: crypto.randomUUID(),
      idempotencyFingerprint: '{"scope":"earn_program_withdrawal"}',
      providerData: {},
      createdBy: TEST_USER.id,
      initiatedByKeyId: null,
    });
    await createPostgresEarnMovementsRepository(getDb(env)).updateCustodialMovementGuarded({
      selector: { movementId: required(victimRow).id },
      organizationId: "org_test_earn_program_victim",
      toStatus: "processing",
      providerReference: "wd_victim_org",
    });

    const res = await requestEarn(
      "GET",
      programPath(program.id, "/withdrawals/wd_victim_org"),
      undefined,
      {}
    );

    expect(res.status).toBe(404);
    expect(getWithdrawal).not.toHaveBeenCalled();
  });

  describe("GET /programs/:programId/withdrawals — the ledger list", () => {
    it("returns the house list envelope from the ledger, newest first", async () => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      vi.spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_a" })
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_b", status: "completed" });
      await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        createBody({ requestId: crypto.randomUUID(), amountUsd: "10.00" }),
        {}
      );
      await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        createBody({ requestId: crypto.randomUUID(), amountUsd: "20.00" }),
        {}
      );

      const res = await requestEarn("GET", programPath(program.id, "/withdrawals"), undefined, {});

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
      expect(required(record).id).toMatch(/^earn_movement_/);
      expect(required(record).provider).toBe("upshift");
      expect(required(record).destinationAddress).toBe(SOLANA_DESTINATION);

      expect(record).not.toHaveProperty("requestId");
      expect(record).not.toHaveProperty("idempotencyFingerprint");

      const page2 = await requestEarn(
        "GET",
        programPath(program.id, "/withdrawals?page=2&pageSize=1"),
        undefined,
        {}
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
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);
      await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody({}), {});

      env.UPSHIFT_SANDBOX_API_KEY = undefined;
      const live = await requestEarn("GET", programPath(program.id, ""), undefined, {});
      expect(live.status).toBe(503);

      const list = await requestEarn("GET", programPath(program.id, "/withdrawals"), undefined, {});
      expect(list.status).toBe(200);
      const body = (await list.json()) as { data: { total: number } };
      expect(body.data.total).toBe(1);
    });

    it("returns 404 for a program id that does not exist", async () => {
      await seedAuth({ entitleGround: true });

      const res = await requestEarn(
        "GET",
        programPath("earn_provider_wallet_missing", "/withdrawals"),
        undefined,
        {}
      );

      expect(res.status).toBe(404);
    });

    it("never serves the sandbox ledger to a production-project Clerk", async () => {
      await seedAuth({ entitleGround: true });
      await seedClerkAuth();
      const program = await seedProgramWallet({});
      vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);
      await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody({}), {});

      const res = await requestEarnAsClerk(
        "GET",
        programPath(program.id, "/withdrawals"),
        TEST_PRODUCTION_PROJECT.id
      );

      expect(res.status).toBe(404);
    });
  });
});

describe("Earn program — withdrawal authorization (HOO-1559)", () => {
  const WALLET_SCOPED_KEY = {
    id: "key_earn_program_scoped",
    raw: "sk_test_earn_program_scoped",
    prefix: "sk_test_eps",
  };

  const withdrawBody = (extra: Record<string, unknown>) => ({
    requestId: crypto.randomUUID(),
    amountUsd: "25.50",
    token: "usdc",
    destinationAddress: SOLANA_DESTINATION,
    ...extra,
  });

  async function seedWalletScopedKey(): Promise<void> {
    const keyHash = await hashString(WALLET_SCOPED_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_CACHED_API_KEY,
      id: WALLET_SCOPED_KEY.id,
      walletScope: "selected",
      signingWalletId: "privy_low_value",
      walletBindings: [{ walletId: "privy_low_value", permissions: ["*"] }],
    });
    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        WALLET_SCOPED_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Wallet-scoped key",
        WALLET_SCOPED_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      )
      .run();
  }

  function requestAsWalletScopedKey(method: string, path: string, body?: Record<string, unknown>) {
    return app.request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WALLET_SCOPED_KEY.raw}`,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      env
    );
  }

  async function seedApiKeyControlProfile(params: {
    rules: Record<string, unknown>[];
    defaultAction: string;
  }): Promise<void> {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profiles
             (id, organization_id, project_id, api_key_id, name, status)
           VALUES (?, ?, ?, ?, ?, 'active')`
        )
        .bind("akcp_earn_program", TEST_ORG.id, TEST_PROJECT.id, TEST_API_KEY.id, "Earn controls"),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profile_revisions
             (id, profile_id, revision_number, rules, default_action, created_by, activated_at)
           VALUES (?, ?, 1, ?::jsonb, ?, ?, ?)`
        )
        .bind(
          "akcpr_earn_program_1",
          "akcp_earn_program",
          JSON.stringify(params.rules),
          params.defaultAction,
          TEST_USER.id,
          "2026-09-07T00:00:00.000Z"
        ),
      getDb(env)
        .prepare(
          "UPDATE api_key_control_profiles SET active_revision_id = ?, activated_at = ? WHERE id = ?"
        )
        .bind("akcpr_earn_program_1", "2026-09-07T00:00:00.000Z", "akcp_earn_program"),
    ]);
  }

  async function readWalletOperations() {
    const rows = await getDb(env)
      .prepare(
        `SELECT id, status, operation_family, operation_type, custody_wallet_id, wallet_id,
                asset, amount, destination
           FROM wallet_operations ORDER BY created_at ASC, id ASC`
      )
      .all<{
        id: string;
        status: string;
        operation_family: string;
        operation_type: string;
        custody_wallet_id: string | null;
        wallet_id: string;
        asset: string | null;
        amount: string | null;
        destination: string | null;
      }>();
    return rows.results;
  }

  async function countMovements(): Promise<number> {
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS total FROM earn_movements")
      .first<{ total: number }>();
    return required(row).total;
  }

  it("refuses a wallet-scoped key on the payout, before the provider is driven", async () => {
    await seedAuth({ entitleGround: true });
    await seedWalletScopedKey();
    const program = await seedProgramWallet({});
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const res = await requestAsWalletScopedKey(
      "POST",
      programPath(program.id, "/withdrawals"),
      withdrawBody({})
    );

    expect(res.status).toBe(403);
    expect(createWithdrawal).not.toHaveBeenCalled();

    await expect(countMovements()).resolves.toBe(0);
  });

  it("refuses a wallet-scoped key on the liquidity preview it shares a chain with", async () => {
    await seedAuth({ entitleGround: true });
    await seedWalletScopedKey();
    const program = await seedProgramWallet({});
    const preview = vi.spyOn(portfolioClient, "previewPortfolioWithdrawal");

    const res = await requestAsWalletScopedKey(
      "POST",
      programPath(program.id, "/withdrawal-preview"),
      { token: "usdc" }
    );

    expect(res.status).toBe(403);
    expect(preview).not.toHaveBeenCalled();
  });

  it("still serves an unbound key, and records the payout as a governed operation", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const res = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      withdrawBody({ requestId: "1d7f9a30-4c21-4f0e-9f66-2b8a51c7e0d4" }),
      {}
    );

    expect(res.status).toBe(201);

    expect(await readWalletOperations()).toMatchObject([
      {
        status: "evaluated",
        operation_family: "program",
        operation_type: "earn_program_withdrawal",
        custody_wallet_id: null,
        wallet_id: WALLET_REF,
        asset: "usdc",
        amount: "25.50",
        destination: SOLANA_DESTINATION,
      },
    ]);
  });

  it("denies a destination the key's policy forbids, before the provider is driven", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    await seedApiKeyControlProfile({
      defaultAction: "allow",
      rules: [
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: ["11111111111111111111111111111111"],
          action: "allow",
        },
      ],
    });
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const res = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      withdrawBody({ requestId: "6c2d1b84-3f57-4a0d-9d2b-7e41f5a9c308" }),
      {}
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { decision: string } } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details.decision).toBe("deny");

    expect(createWithdrawal).not.toHaveBeenCalled();
    await expect(countMovements()).resolves.toBe(0);
  });

  it("holds a payout the policy requires approval for, and a retry re-answers the same hold", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    await seedApiKeyControlProfile({
      defaultAction: "allow",
      rules: [{ id: "approve-everything", kind: "always", action: "approval_required" }],
    });
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    const body = withdrawBody({ requestId: "b5a0c9e2-8d14-4b73-9c5f-0e6a2d8f4713" });

    const held = await requestEarn("POST", programPath(program.id, "/withdrawals"), body, {});
    expect(held.status).toBe(202);

    const retried = await requestEarn("POST", programPath(program.id, "/withdrawals"), body, {});
    expect(retried.status).toBe(202);

    expect(createWithdrawal).not.toHaveBeenCalled();
    await expect(countMovements()).resolves.toBe(0);
    const operations = await readWalletOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "pending_approval" });
  });
});

describe("Earn program — governed payout, execution and blast radius (HOO-1559)", () => {
  it("admits the program as an operation target for its OWN type only", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const repo = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    const candidate = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: null,
      walletId: program.provider_wallet_ref,
      apiKeyId: TEST_API_KEY.id,
      actor: null,
      source: "test",
      asset: "usdc",
      amount: "1.00",
      destination: SOLANA_DESTINATION,
      context: {},
      providerExtensions: {},
      rawPayload: {},
      idempotencyKey: null,
    } as const;

    const admitted = await repo.createWalletOperation({
      ...candidate,
      operationFamily: "program",
      operationType: "earn_program_withdrawal",
    });
    // Admission only means something if what it persisted IS the operation the
    // candidate described, scoped to this tenant and fresh: a garbage row —
    // another wallet, a foreign org, a drifted type, a stale status — used to
    // pass a merely non-null check.
    expect(admitted).not.toBeNull();
    expect(admitted).toMatchObject({
      organization_id: TEST_ORG.id,
      project_id: TEST_PROJECT.id,
      wallet_id: program.provider_wallet_ref,
      custody_wallet_id: null,
      api_key_id: TEST_API_KEY.id,
      operation_family: "program",
      operation_type: "earn_program_withdrawal",
      asset: "usdc",
      amount: "1.00",
      destination: SOLANA_DESTINATION,
      status: "created",
    });

    await expect(
      repo.createWalletOperation({
        ...candidate,
        idempotencyKey: null,
        operationFamily: "issuance",
        operationType: "issuance_mint_execute",
      })
    ).resolves.toBeNull();
  });

  it.each(["recovery", "http"])(
    "pays out a body-keyed withdrawal through %s approval execution",
    async (execution) => {
      await seedAuth({ entitleGround: true });
      const program = await seedProgramWallet({});
      await getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profiles
           (id, organization_id, project_id, api_key_id, name, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
        )
        .bind("akcp_exec", TEST_ORG.id, TEST_PROJECT.id, TEST_API_KEY.id, "Approve payouts")
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO api_key_control_profile_revisions
           (id, profile_id, revision_number, rules, default_action, created_by, activated_at)
         VALUES (?, ?, 1, ?::jsonb, 'allow', ?, ?)`
        )
        .bind(
          "akcpr_exec_1",
          "akcp_exec",
          JSON.stringify([
            {
              id: "approve-program-withdrawals",
              kind: "approval",
              operationTypes: ["earn_program_withdrawal"],
            },
          ]),
          TEST_USER.id,
          "2026-09-07T00:00:00.000Z"
        )
        .run();
      await getDb(env)
        .prepare(
          "UPDATE api_key_control_profiles SET active_revision_id = ?, activated_at = ? WHERE id = ?"
        )
        .bind("akcpr_exec_1", "2026-09-07T00:00:00.000Z", "akcp_exec")
        .run();

      const createWithdrawal = vi
        .spyOn(portfolioClient, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const held = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        {
          requestId: "7f3c8e51-2a94-4d6b-b0e7-1c5a9f28d403",
          amountUsd: "25.50",
          token: "usdc",
          destinationAddress: SOLANA_DESTINATION,
        },
        {}
      );
      expect(held.status).toBe(202);
      expect(createWithdrawal).not.toHaveBeenCalled();
      const heldBody = (await held.json()) as {
        error: { details: { approvalRequestId: string; walletOperationId: string } };
      };

      const policyRepository = createPostgresPolicyRepository(
        getDb(env),
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
      );
      if (execution === "recovery") {
        await policyRepository.updateApprovalRequestStatus({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          approvalRequestId: heldBody.error.details.approvalRequestId,
          status: "approved",
          operationStatus: "executing",
          resolvedBy: TEST_API_KEY.id,
        });
        expect(await recoverApprovedWalletOperations(env)).toBe(1);
      } else {
        const approverKey = "sk_test_program_approver";
        const approverHash = await hashString(approverKey, env.API_KEY_PEPPER);
        await getDb(env).batch([
          getDb(env).prepare(
            `INSERT INTO users (id, email, email_verified, status)
           VALUES ('usr_test_program_approver', 'program-approver@example.com', 1, 'active')`
          ),
          getDb(env)
            .prepare(
              `INSERT INTO api_keys (id, organization_id, project_id, created_by, name,
             key_prefix, key_hash, role, permissions, status)
           VALUES ('key_program_approver', ?, ?, 'usr_test_program_approver', 'Approver',
             'sk_test_prog', ?, 'api_admin', '["*"]', 'active')`
            )
            .bind(TEST_ORG.id, TEST_PROJECT.id, approverHash),
        ]);
        await seedCachedApiKey(env, approverHash, {
          ...TEST_CACHED_API_KEY,
          id: "key_program_approver",
        });
        const path = `/v1/wallets/approval-requests/${heldBody.error.details.approvalRequestId}/approve`;
        const headers = { Authorization: `Bearer ${approverKey}` };
        const flag = env.PRIVY_BYOK_ENABLED;
        env.PRIVY_BYOK_ENABLED = "false";
        try {
          const response = await app.request(path, { method: "POST", headers }, env);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            data: { approvalRequest: { status: "approved", operation: { status: "completed" } } },
          });
        } finally {
          env.PRIVY_BYOK_ENABLED = flag;
        }
      }

      expect(createWithdrawal).toHaveBeenCalledTimes(1);
      const executed = await policyRepository.getWalletOperationById(
        heldBody.error.details.walletOperationId
      );
      expect(executed).toMatchObject({ status: "completed", execution_error: null });
    }
  );
});

describe("Earn program — metered quotas", () => {
  it("429s a program read once the actor's quota is exhausted", async () => {
    await seedAuth({ entitleGround: true });
    await seedProgramWallet({});
    const getWallet = stubProgramReads();
    await seedRateLimit(
      env,
      `metered:earn-provider-read:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`,
      60
    );

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=upshift`, undefined, {});

    expect(res.status).toBe(429);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });

    expect(getWallet).not.toHaveBeenCalled();
  });

  it("never lets an exhausted quota stand between a caller and its money", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    const createWithdrawal = vi
      .spyOn(portfolioClient, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    const preview = vi
      .spyOn(portfolioClient, "previewPortfolioWithdrawal")
      .mockResolvedValue({ withdrawableUsd: "100.00" } as never);

    for (const quota of ["earn-provider-read", "earn-chain-read"]) {
      await seedRateLimit(env, `metered:${quota}:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`, 1000);
      await seedRateLimit(env, `metered:${quota}:org:${TEST_ORG.id}`, 1000);
    }

    const liquidity = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawal-preview"),
      {
        token: "usdc",
      },
      {}
    );
    expect(liquidity.status).toBe(200);
    expect(preview).toHaveBeenCalledTimes(1);

    const withdrawal = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      {
        requestId: "2e8b1f47-5c93-4a2d-8e16-9d4f0a7b3c25",
        amountUsd: "25.50",
        token: "usdc",
        destinationAddress: SOLANA_DESTINATION,
      },
      {}
    );
    expect(withdrawal.status).toBe(201);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
  });
});

describe("Earn program: withdrawal audit parity (PRO-1866)", () => {
  it("records the payout with the movement's attribution, and a replay is not re-audited", async () => {
    await seedAuth({ entitleGround: true });
    const program = await seedProgramWallet({});
    vi.spyOn(portfolioClient, "createPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);
    vi.spyOn(portfolioClient, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);
    const body = {
      requestId: "8d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a",
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
    };

    const res = await requestEarn("POST", programPath(program.id, "/withdrawals"), body, {});
    expect(res.status).toBe(201);

    const movement = await getDb(env)
      .prepare("SELECT * FROM earn_movements WHERE direction = 'withdrawal'")
      .first<Record<string, unknown>>();
    const auditRows = () =>
      getDb(env)
        .prepare(
          "SELECT * FROM audit_logs WHERE action = 'withdraw' AND resource_type = 'earn_movement'"
        )
        .all<Record<string, unknown>>()
        .then(({ results }) => results);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_id: required(movement).id,
      organization_id: TEST_ORG.id,
      user_id: required(movement).created_by,
      api_key_id: required(movement).initiated_by_key_id,
    });

    const feed = await new AuditService(getDb(env)).getForOrganization(TEST_ORG.id, {
      action: "withdraw",
    });
    expect(feed.some((entry) => entry.resourceId === required(movement).id)).toBe(true);

    const replay = await requestEarn("POST", programPath(program.id, "/withdrawals"), body, {});
    expect(replay.status).toBe(200);
    await expect(auditRows()).resolves.toHaveLength(1);
  });
});
