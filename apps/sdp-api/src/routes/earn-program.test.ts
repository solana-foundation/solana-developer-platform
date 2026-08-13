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
  type InsertEarnProviderWalletInput,
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
/** Second provider wallet — PRO-1670 lets ONE org hold both at once. */
const WALLET_REF_B = "2b6e1f80-7a3c-4f0d-9b21-5c8d4e2f1a03";
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

/**
 * Seed one program link row. Overridable because PRO-1670 makes N programs per
 * (organization, environment, provider) legal, and every multi-program case
 * needs a DISTINCT `providerWalletRef` — migration 0056's global
 * UNIQUE (provider, provider_wallet_ref) rejects a repeat platform-wide.
 * Callers keep the returned row: its `id` is how every route names the program.
 */
async function seedProgramWallet(
  overrides: Partial<InsertEarnProviderWalletInput> = {}
): Promise<EarnProviderWalletRow> {
  const row = await createPostgresEarnRepository(getDb(env)).insertProviderWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "ground",
    providerWalletRef: WALLET_REF,
    label: "Test Program",
    createdBy: TEST_USER.id,
    ...overrides,
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

/** Every per-program route is `/v1/earn/programs/:programId[...]`. */
const PROGRAMS_PATH = "/v1/earn/programs";
const programPath = (programId: string, suffix = "") => `${PROGRAMS_PATH}/${programId}${suffix}`;

const createProgramBody = (extra: Record<string, unknown> = {}) => ({
  provider: "ground",
  allocations: VALID_ALLOCATIONS,
  ...extra,
});

/** The derived id the provider actually dedupes a program CREATE on. */
const derivedCreateId = (callerKey: string, environment = "sandbox") =>
  deriveProviderRequestId(["earn_program_create", TEST_ORG.id, environment, "ground"], callerKey);

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

/**
 * Live-read stubs for anything that reaches `loadProgramState`.
 *
 * `getPortfolioWallet` is stubbed with mockIMPLEMENTATION, never
 * `mockResolvedValue`: a single shared snapshot ignores its arguments, so a
 * handler that resolved the WRONG program would still return a plausible-looking
 * body and every multi-program assertion below would pass vacuously. Echoing the
 * requested ref back is what makes "this program served its own wallet"
 * observable.
 *
 * The yield leg is best-effort in the handler, so a rejection reproduces the
 * shape of a response with no `yield` key while keeping the suite off the
 * network.
 */
function stubProgramReads() {
  vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioYield").mockRejectedValue(
    new Error("yield unavailable in tests")
  );
  return vi
    .spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWallet")
    .mockImplementation(async (_ctx, { providerWalletRef }) => ({
      ...WALLET_SNAPSHOT,
      providerWalletRef,
    }));
}

/**
 * A provider that dedupes creates on the request id it was sent — which is what
 * makes a retried create safe. The same derived id always yields the ORIGINAL
 * wallet ref, so SDP's second insert lands on 0056's global unique and the
 * handler must read that as a replay rather than a race.
 */
function stubProviderWalletDedupe() {
  const minted = new Map<string, string>();
  return vi
    .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
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
  return row?.total ?? 0;
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

describe("Earn program — POST /programs (create) and PUT /programs/:id (re-target)", () => {
  it("creates a program, then re-targets that program in place", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    const callerKey = crypto.randomUUID();
    const created = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ label: "Treasury", requestId: callerKey })
    );

    expect(created.status).toBe(201);
    const createdBody = (await created.clone().json()) as { data: Record<string, unknown> };
    // `created: boolean` left the wire with PRO-1670 — the status code carries it.
    expect(createdBody.data).not.toHaveProperty("created");
    const program = await readProgram(created);
    expect(program.id).toMatch(/^earn_provider_wallet_/);
    expect(program.provider).toBe("ground");
    expect(program.label).toBe("Treasury");
    expect(program.wallet).toEqual(WALLET_SNAPSHOT);
    expect(createWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      label: "Treasury",
      allocations: VALID_ALLOCATIONS,
      requestId: derivedCreateId(callerKey),
    });
    expect(updateStrategy).not.toHaveBeenCalled();

    // The link row is addressable by its own id, scoped to (org, environment).
    const row = await createPostgresEarnRepository(getDb(env)).getProviderWalletById({
      organizationId: TEST_ORG.id,
      environment: "sandbox",
      walletId: program.id,
    });
    expect(row?.provider_wallet_ref).toBe(WALLET_REF);

    // Re-target is now an explicit verb on the program, not an implicit second
    // PUT that may or may not have created something.
    const retargeted = await requestEarn("PUT", programPath(program.id), {
      allocations: VALID_ALLOCATIONS,
    });

    expect(retargeted.status).toBe(200);
    expect((await readProgram(retargeted)).id).toBe(program.id);
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(updateStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
      { providerWalletRef: WALLET_REF, allocations: VALID_ALLOCATIONS }
    );
  });

  it("derives the provider request id on both branches — never forwards the caller's raw key", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
      .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
    const updateStrategy = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    // Every organization shares one provider account, so a key that reached the
    // provider verbatim would let two tenants collide on the same pasted UUID —
    // the second answered with a replay of the first's wallet.
    const createRequestId = "3f1d5a2e-9b64-4c7f-8a10-2d5e6f7a8b90";
    const retargetRequestId = "5c2e7b41-8d36-4a92-bf05-1e4c9a7d3b28";

    const created = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: createRequestId })
    );
    expect(created.status).toBe(201);
    const program = await readProgram(created);
    const sentOnCreate = createWallet.mock.calls[0]?.[1]?.requestId;
    expect(sentOnCreate).toBe(derivedCreateId(createRequestId));
    expect(sentOnCreate).not.toBe(createRequestId);
    expect(sentOnCreate).toMatch(UUID_V4_PATTERN);

    const retargeted = await requestEarn("PUT", programPath(program.id), {
      allocations: VALID_ALLOCATIONS,
      requestId: retargetRequestId,
    });
    expect(retargeted.status).toBe(200);
    const sentOnRetarget = updateStrategy.mock.calls[0]?.[1]?.requestId;
    // Scoped by the WALLET, so one caller key used against two of the org's own
    // programs cannot collapse into a single provider mutation.
    expect(sentOnRetarget).toBe(
      deriveProviderRequestId(["earn_program_retarget", WALLET_REF], retargetRequestId)
    );
    expect(sentOnRetarget).not.toBe(retargetRequestId);
  });

  it("honors an Idempotency-Key header on re-target exactly like its siblings", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const program = await seedProgramWallet();
    const updateStrategy = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy")
      .mockResolvedValue({ allocations: WALLET_SNAPSHOT.allocations });
    stubProgramReads();

    // The platform middleware echoes this header on every /v1/* response, so a
    // route that silently dropped it would look keyed while minting a fresh
    // provider id per attempt — the exact non-idempotency the key exists to
    // prevent. Header-only must derive; header+body must refuse.
    const headerKey = "retarget-9f2b";
    const retargeted = await requestEarn(
      "PUT",
      programPath(program.id),
      { allocations: VALID_ALLOCATIONS },
      { "Idempotency-Key": headerKey }
    );
    expect(retargeted.status).toBe(200);
    expect(updateStrategy.mock.calls[0]?.[1]?.requestId).toBe(
      deriveProviderRequestId(["earn_program_retarget", program.provider_wallet_ref], headerKey)
    );

    const both = await requestEarn(
      "PUT",
      programPath(program.id),
      { allocations: VALID_ALLOCATIONS, requestId: crypto.randomUUID() },
      { "Idempotency-Key": headerKey }
    );
    expect(both.status).toBe(400);
    expect(updateStrategy).toHaveBeenCalledTimes(1);
  });

  it("refuses re-target when the organization is not entitled or credentials are missing", async () => {
    // Re-target is money-in (it points the balance at a different strategy), so
    // it takes the FULL availability gate — the same asymmetry pinned for the
    // create above and the reason a disabled provider still allows withdrawals.
    await seedAuth({ entitleGround: false });
    await seedGroundStrategy();
    const program = await seedProgramWallet();
    const updateStrategy = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "updatePortfolioStrategy");

    const unentitled = await requestEarn("PUT", programPath(program.id), {
      allocations: VALID_ALLOCATIONS,
    });
    expect(unentitled.status).toBe(403);

    await clearKVStores(env);
    await seedTestDatabase(env);
    await seedAuth();
    await seedGroundStrategy();
    const reseeded = await seedProgramWallet();
    env.GROUND_SANDBOX_API_KEY = undefined;

    const noCredentials = await requestEarn("PUT", programPath(reseeded.id), {
      allocations: VALID_ALLOCATIONS,
    });
    expect(noCredentials.status).toBe(403);
    expect(updateStrategy).not.toHaveBeenCalled();
  });

  it("rejects a requestId that is not a UUIDv4", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: "not-a-uuid" })
    );

    expect(res.status).toBe(400);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("rejects allocations referencing yield sources outside the synced catalogue", async () => {
    await seedAuth();
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: { usdc: [{ yieldSourceId: "morpho-unknown-usdc", pct: 100 }] },
        requestId: crypto.randomUUID(),
      })
    );

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
    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: {
          usdc: [
            { yieldSourceId: GROUND_SOURCE, pct: 50 },
            { yieldSourceId: "morpho-steakhouse-usdc", pct: 50 },
          ],
        },
        requestId: crypto.randomUUID(),
      })
    );

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
    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: { usdc: [{ yieldSourceId: GROUND_SOURCE, pct: 60 }] },
        requestId: crypto.randomUUID(),
      })
    );

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
    stubProgramReads();

    // The cap is per token group, not per body: usdc and usdt each carry one vault.
    const res = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({
        allocations: {
          usdc: [{ yieldSourceId: GROUND_SOURCE, pct: 100 }],
          usdt: [{ yieldSourceId: GROUND_USDT_SOURCE, pct: 100 }],
        },
        requestId: crypto.randomUUID(),
      })
    );

    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalledTimes(1);
  });

  it("blocks create when the organization is not entitled or credentials are missing", async () => {
    await seedAuth({ entitleGround: false });
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    const unentitled = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() })
    );
    expect(unentitled.status).toBe(403);

    // Entitlement present but the sandbox credential missing also fails closed.
    await clearKVStores(env);
    await seedTestDatabase(env);
    await seedAuth();
    await seedGroundStrategy();
    env.GROUND_SANDBOX_API_KEY = undefined;

    const unconfigured = await requestEarn(
      "POST",
      PROGRAMS_PATH,
      createProgramBody({ requestId: crypto.randomUUID() })
    );
    expect(unconfigured.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("returns 501 for providers without the portfolio-wallet capability", async () => {
    await seedAuth();

    // No idempotency key on purpose: the capability gate runs BEFORE key
    // resolution, so the answer names the real problem instead of a generic 400.
    const res = await requestEarn("POST", PROGRAMS_PATH, {
      provider: "veda",
      allocations: VALID_ALLOCATIONS,
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("answers an unentitled create 403 even when no idempotency key was sent", async () => {
    await seedAuth({ entitleGround: false });
    await seedGroundStrategy();
    const createWallet = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet");

    // Key resolution is deliberately LAST in createEarnProgram. If it moved
    // earlier this would 400 "missing idempotency key", hiding the fact that
    // the call could never have worked for this organization.
    const res = await requestEarn("POST", PROGRAMS_PATH, createProgramBody());

    expect(res.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  describe("required idempotency key (PRO-1670)", () => {
    it("refuses both key sources and neither, and accepts the header alone", async () => {
      await seedAuth();
      await seedGroundStrategy();
      const createWallet = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWallet")
        .mockResolvedValue({ providerWalletRef: WALLET_REF, status: "creating" });
      stubProgramReads();

      // The trap: a retry layer that preserves headers while the request layer
      // mints a fresh body id per attempt keeps Idempotency-Key stable and varies
      // requestId. Any precedence rule follows the varying one and provisions a
      // SECOND wallet the customer's first deposit would never reach.
      const both = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: "0d7fbb1e-9b26-4b8f-8f5e-2a1f4a3b6c9d" }),
        { "Idempotency-Key": "onboarding-9f2b" }
      );
      expect(both.status).toBe(400);

      // Refusing beats accepting: a server-minted id is fresh per attempt, so it
      // would guarantee the duplicate program it appears to guard against.
      const neither = await requestEarn("POST", PROGRAMS_PATH, createProgramBody());
      expect(neither.status).toBe(400);
      expect(createWallet).not.toHaveBeenCalled();

      const headerOnly = await requestEarn("POST", PROGRAMS_PATH, createProgramBody(), {
        "Idempotency-Key": "onboarding-9f2b",
      });
      expect(headerOnly.status).toBe(201);
      expect(createWallet).toHaveBeenCalledTimes(1);
      expect(createWallet.mock.calls[0]?.[1]?.requestId).toBe(derivedCreateId("onboarding-9f2b"));
    });

    it("provisions exactly ONE wallet when the same caller key is retried", async () => {
      await seedAuth();
      await seedGroundStrategy();
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const callerKey = crypto.randomUUID();
      const first = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: callerKey })
      );
      const retry = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: callerKey })
      );

      expect(first.status).toBe(201);
      // The retry is a REPLAY, not a conflict: the provider answered the same
      // derived key with the ORIGINAL wallet ref, so the second insert hit
      // 0056's global unique and the handler served the existing program.
      expect(retry.status).toBe(200);
      expect((await readProgram(retry)).id).toBe((await readProgram(first)).id);
      // The provider was asked twice and deduped — SDP never assumed it wouldn't be.
      expect(createWallet).toHaveBeenCalledTimes(2);
      expect(createWallet.mock.calls[1]?.[1]?.requestId).toBe(
        createWallet.mock.calls[0]?.[1]?.requestId
      );
      await expect(countProviderWallets()).resolves.toBe(1);
    });

    it("provisions exactly ONE wallet when the same caller key arrives concurrently", async () => {
      await seedAuth();
      await seedGroundStrategy();
      stubProviderWalletDedupe();
      stubProgramReads();

      const callerKey = crypto.randomUUID();
      const [a, b] = await Promise.all([
        requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: callerKey })),
        requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: callerKey })),
      ]);

      // Whoever loses the insert race takes the replay path, not a 409.
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((await readProgram(a)).id).toBe((await readProgram(b)).id);
      await expect(countProviderWallets()).resolves.toBe(1);
    });

    it("provisions TWO wallets for two different caller keys", async () => {
      await seedAuth();
      await seedGroundStrategy();
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const first = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: crypto.randomUUID() })
      );
      const second = await requestEarn(
        "POST",
        PROGRAMS_PATH,
        createProgramBody({ requestId: crypto.randomUUID() })
      );

      // A genuine second program is the point of PRO-1670 — only the KEY
      // separates it from a retry.
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const [programA, programB] = [await readProgram(first), await readProgram(second)];
      expect(programA.id).not.toBe(programB.id);
      expect(programA.wallet.providerWalletRef).not.toBe(programB.wallet.providerWalletRef);
      expect(createWallet.mock.calls[0]?.[1]?.requestId).not.toBe(
        createWallet.mock.calls[1]?.[1]?.requestId
      );
      await expect(countProviderWallets()).resolves.toBe(2);
    });

    it("gives each unlabelled program its own default provider label", async () => {
      await seedAuth();
      await seedGroundStrategy();
      const createWallet = stubProviderWalletDedupe();
      stubProgramReads();

      const keyOne = crypto.randomUUID();
      const keyTwo = crypto.randomUUID();
      await requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: keyOne }));
      await requestEarn("POST", PROGRAMS_PATH, createProgramBody({ requestId: keyTwo }));

      // The suffix comes from the DERIVED key, so a provider replay of a retried
      // create reproduces the same payload — but two DIFFERENT programs must
      // never share a provider-side name.
      const labelOne = createWallet.mock.calls[0]?.[1]?.label;
      const labelTwo = createWallet.mock.calls[1]?.[1]?.label;
      expect(labelOne).toBe(
        `sdp-earn-${TEST_ORG.id}-sandbox-${derivedCreateId(keyOne).slice(0, 8)}`
      );
      expect(labelTwo).toBe(
        `sdp-earn-${TEST_ORG.id}-sandbox-${derivedCreateId(keyTwo).slice(0, 8)}`
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
    await seedAuth();
    const a = await seedProgramWallet({ providerWalletRef: WALLET_REF, label: "Program A" });
    const b = await seedProgramWallet({ providerWalletRef: WALLET_REF_B, label: "Program B" });
    return { a, b };
  }

  const withdrawalBody = (extra: Record<string, unknown> = {}) => ({
    amountUsd: "10.00",
    token: "usdc",
    destinationAddress: SOLANA_DESTINATION,
    ...extra,
  });

  it("lists both programs with distinct ids and each one's OWN live snapshot", async () => {
    const { a, b } = await seedTwoPrograms();
    const getWallet = stubProgramReads();

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=ground`);

    expect(res.status).toBe(200);
    const page = await readPrograms(res);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(page.programs.map((program) => program.id).sort()).toEqual([a.id, b.id].sort());

    // Each row carries the snapshot of ITS wallet — the whole reason the stub
    // reads its arguments instead of answering with one shared object.
    const byId = new Map(page.programs.map((program) => [program.id, program]));
    expect(byId.get(a.id)?.wallet.providerWalletRef).toBe(WALLET_REF);
    expect(byId.get(a.id)?.label).toBe("Program A");
    expect(byId.get(b.id)?.wallet.providerWalletRef).toBe(WALLET_REF_B);
    expect(byId.get(b.id)?.label).toBe("Program B");
    expect(getWallet).toHaveBeenCalledTimes(2);

    // The page window is DB-side: a 1-per-page page still reports the full total.
    const paged = await requestEarn("GET", `${PROGRAMS_PATH}?provider=ground&page=2&pageSize=1`);
    expect(paged.status).toBe(200);
    const pagedBody = await readPrograms(paged);
    expect(pagedBody).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(pagedBody.programs).toHaveLength(1);
  });

  it("serves each program id its own wallet, never its sibling's", async () => {
    const { a, b } = await seedTwoPrograms();
    const getWallet = stubProgramReads();

    const detailA = await requestEarn("GET", programPath(a.id));
    const detailB = await requestEarn("GET", programPath(b.id));

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
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockImplementation(async (_ctx, input) => ({
        ...WITHDRAWAL,
        withdrawalRef: input.providerWalletRef === WALLET_REF ? "wd_a" : "wd_b",
      }));

    const createdA = await requestEarn(
      "POST",
      programPath(a.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() })
    );
    const createdB = await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() })
    );

    expect(createdA.status).toBe(201);
    expect(createdB.status).toBe(201);
    expect(createWithdrawal.mock.calls[0]?.[1]?.providerWalletRef).toBe(WALLET_REF);
    expect(createWithdrawal.mock.calls[1]?.[1]?.providerWalletRef).toBe(WALLET_REF_B);

    // The ledger list is wallet-scoped, so program A's history is only A's.
    const listA = await requestEarn("GET", programPath(a.id, "/withdrawals"));
    expect(listA.status).toBe(200);
    const bodyA = (await listA.json()) as {
      data: { withdrawals: Array<{ withdrawalRef?: string }>; total: number };
    };
    expect(bodyA.data.total).toBe(1);
    expect(bodyA.data.withdrawals.map((w) => w.withdrawalRef)).toEqual(["wd_a"]);
    expect(bodyA.data.withdrawals.map((w) => w.withdrawalRef)).not.toContain("wd_b");

    const listB = await requestEarn("GET", programPath(b.id, "/withdrawals"));
    const bodyB = (await listB.json()) as {
      data: { withdrawals: Array<{ withdrawalRef?: string }>; total: number };
    };
    expect(bodyB.data.total).toBe(1);
    expect(bodyB.data.withdrawals.map((w) => w.withdrawalRef)).toEqual(["wd_b"]);
  });

  it("derives two DISTINCT provider request ids from one caller key across two programs", async () => {
    const { a, b } = await seedTwoPrograms();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockImplementation(async (_ctx, input) => ({
        ...WITHDRAWAL,
        withdrawalRef: input.providerWalletRef === WALLET_REF ? "wd_a" : "wd_b",
      }));

    // One org now holds several programs, so the wallet — not the org — is what
    // keeps a single reused key from collapsing two payouts into one.
    const shared = "00000000-0000-4000-8000-000000000000";
    const fromA = await requestEarn(
      "POST",
      programPath(a.id, "/withdrawals"),
      withdrawalBody({ requestId: shared })
    );
    const fromB = await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: shared })
    );

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    const sentA = createWithdrawal.mock.calls[0]?.[1]?.requestId;
    const sentB = createWithdrawal.mock.calls[1]?.[1]?.requestId;
    expect(sentA).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], shared));
    expect(sentB).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF_B], shared));
    expect(sentA).not.toBe(sentB);

    const count = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS total FROM earn_program_withdrawals")
      .first<{ total: number }>();
    expect(count?.total).toBe(2);
  });

  it("404s program A's request for program B's withdrawal ref (intra-org BOLA guard)", async () => {
    const { a, b } = await seedTwoPrograms();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      withdrawalRef: "wd_b",
    });
    await requestEarn(
      "POST",
      programPath(b.id, "/withdrawals"),
      withdrawalBody({ requestId: crypto.randomUUID() })
    );
    const getWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal")
      .mockResolvedValue({ ...WITHDRAWAL, withdrawalRef: "wd_b" });

    // The guard compares the PROGRAM, not the organization: an org-only check
    // was complete while an org held one program, but here it would pass and
    // then drive the provider with A's wallet ref and B's withdrawal ref.
    const crossRead = await requestEarn("GET", programPath(a.id, "/withdrawals/wd_b"));

    expect(crossRead.status).toBe(404);
    expect(getWithdrawal).not.toHaveBeenCalled();

    // B's own program still reads it, so the guard is scoping and not a blanket ban.
    const ownRead = await requestEarn("GET", programPath(b.id, "/withdrawals/wd_b"));
    expect(ownRead.status).toBe(200);
    expect(getWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("404s another organization's program id", async () => {
    await seedAuth();
    const getWallet = stubProgramReads();

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
        )
        .bind("org_earn_program_neighbour", "Neighbour Org", "earn-program-neighbour"),
      db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Neighbour Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(
          "prj_earn_program_neighbour",
          "org_earn_program_neighbour",
          "neighbour-project",
          TEST_USER.id
        ),
    ]);
    const foreign = await seedProgramWallet({
      organizationId: "org_earn_program_neighbour",
      projectId: "prj_earn_program_neighbour",
      providerWalletRef: "9a35f56f-deeb-478f-8c7c-4d2b6d8f0e32",
      label: null,
    });

    // A program id is caller-supplied now, so getProviderWalletById carries the
    // tenancy proof the old (org, environment, provider) lookup made structural.
    const res = await requestEarn("GET", programPath(foreign.id));

    expect(res.status).toBe(404);
    expect(getWallet).not.toHaveBeenCalled();
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
    stubProgramReads();

    const callerKey = crypto.randomUUID();
    const res = await requestEarnAsSession(
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
        // Environment is part of the derivation scope, so the same caller key
        // in sandbox is a different provider request.
        requestId: derivedCreateId(callerKey, "production"),
      })
    );

    // The row lands under production with no sandbox sibling…
    const repo = createPostgresEarnRepository(getDb(env));
    const productionRow = await repo.getProviderWalletById({
      organizationId: TEST_ORG.id,
      environment: "production",
      walletId: program.id,
    });
    expect(productionRow?.provider_wallet_ref).toBe(WALLET_REF);
    expect(productionRow?.environment).toBe("production");
    await expect(
      repo.listProviderWallets({
        organizationId: TEST_ORG.id,
        environment: "sandbox",
        limit: 20,
        offset: 0,
      })
    ).resolves.toMatchObject({ rows: [], total: 0 });

    // …so the org's sandbox API key sees an EMPTY collection…
    const sandboxList = await requestEarn("GET", `${PROGRAMS_PATH}?provider=ground`);
    expect(sandboxList.status).toBe(200);
    expect(await readPrograms(sandboxList)).toMatchObject({ programs: [], total: 0 });

    // …and cannot reach the production program by naming its id, which an
    // addressable program id makes a real (new) surface to defend.
    const guessed = await requestEarn("GET", programPath(program.id));
    expect(guessed.status).toBe(404);
  });

  it("never serves a sandbox program to a production-project session", async () => {
    await seedAuth();
    await seedSessionAuth();
    // Production is fully credentialled here on purpose: the isolation must come
    // from the environment scope, not from a missing key.
    env.GROUND_API_KEY = GROUND_PRODUCTION_KEY;
    const program = await seedProgramWallet();
    const getWallet = stubProgramReads();

    const productionList = await requestEarnAsSession(
      "GET",
      `${PROGRAMS_PATH}?provider=ground`,
      TEST_PRODUCTION_PROJECT.id
    );
    expect(productionList.status).toBe(200);
    expect(await readPrograms(productionList)).toMatchObject({ programs: [], total: 0 });

    // The sandbox program's id, presented by the production session, 404s.
    const guessed = await requestEarnAsSession(
      "GET",
      programPath(program.id),
      TEST_PRODUCTION_PROJECT.id
    );
    expect(guessed.status).toBe(404);
    expect(getWallet).not.toHaveBeenCalled();

    // The sandbox-project session still reads the same program, unchanged.
    const sandbox = await requestEarnAsSession("GET", programPath(program.id), TEST_PROJECT.id);
    expect(sandbox.status).toBe(200);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });
});

describe("Earn program — live reads", () => {
  it("returns an empty collection while the organization has no programs", async () => {
    await seedAuth();

    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=ground`);

    expect(res.status).toBe(200);
    expect(await readPrograms(res)).toMatchObject({
      programs: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("runs the credential gate on an EMPTY collection", async () => {
    await seedAuth();
    env.GROUND_SANDBOX_API_KEY = undefined;

    // A collection cannot 404 for emptiness, so without this assert a missing
    // provider key would read as "this organization has no programs" and a
    // dashboard would show onboarding instead of its provider-unconfigured notice.
    const res = await requestEarn("GET", `${PROGRAMS_PATH}?provider=ground`);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("returns 404 for a program id that does not exist", async () => {
    await seedAuth();

    const res = await requestEarn("GET", programPath("earn_provider_wallet_missing"));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("serves the live provider snapshot for an existing program", async () => {
    await seedAuth();
    const program = await seedProgramWallet();
    const getWallet = stubProgramReads();

    const res = await requestEarn("GET", programPath(program.id));

    expect(res.status).toBe(200);
    const body = await readProgram(res);
    expect(body.id).toBe(program.id);
    expect(body.provider).toBe("ground");
    expect(body.label).toBe("Test Program");
    expect(body.wallet).toEqual(WALLET_SNAPSHOT);
    expect(getWallet).toHaveBeenCalledWith(expect.objectContaining({ environment: "sandbox" }), {
      providerWalletRef: WALLET_REF,
    });
  });

  it("passes deposit pagination cursors through to the provider", async () => {
    await seedAuth();
    const program = await seedProgramWallet();
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

    const res = await requestEarn("GET", programPath(program.id, "/deposits?cursor=cursor-1"));

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
    const program = await seedProgramWallet();
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

    const previewRes = await requestEarn("POST", programPath(program.id, "/withdrawal-preview"), {
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

    const withdrawalRes = await requestEarn("POST", programPath(program.id, "/withdrawals"), {
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
      programPath(program.id, `/withdrawals/${WITHDRAWAL.withdrawalRef}`)
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { data: { withdrawal: { status: string } } };
    expect(statusBody.data.withdrawal.status).toBe("processing");
  });

  /**
   * PRO-1675: the preview answers the LIQUIDITY question when asked without an
   * amount, and that optionality must not reach the payout path.
   */
  describe("amount-less preview (the liquidity read)", () => {
    it("omits amountUsd from the provider call and answers with the lane ceiling", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      const preview = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "previewPortfolioWithdrawal")
        .mockResolvedValue({
          feeUsd: "0.10",
          withdrawableUsd: "412.50",
          totalUsdAfterWithdrawal: "412.50",
          processingEstimate: {
            basis: "banking_days",
            typicalMinDuration: "P1D",
            typicalMaxDuration: "P3D",
          },
        });

      const res = await requestEarn("POST", programPath(program.id, "/withdrawal-preview"), {
        token: "usdc",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { preview: { withdrawableUsd: string; amountRequestedUsd?: string } };
      };
      expect(body.data.preview.withdrawableUsd).toBe("412.50");
      // Absent, not null: nothing was requested, so nothing was requested.
      expect(body.data.preview.amountRequestedUsd).toBeUndefined();
      // The provider input must not carry the key at all — a provider keys the
      // two request forms off its PRESENCE, and `undefined` is not omission
      // once it has been spread into an object literal.
      const [, input] = preview.mock.calls[0] ?? [];
      expect(input).toEqual({ providerWalletRef: WALLET_REF, token: "usdc" });
      expect(input && "amountUsd" in input).toBe(false);
    });

    it("keeps amountUsd required on the payout path even though the preview made it optional", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      const createWithdrawal = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal");

      // The regression this pins: the create schema used to `.extend()` the
      // preview schema, so relaxing the preview would have silently accepted a
      // payout with no amount. If this 400 ever becomes a 201, the two schemas
      // have been re-coupled.
      const res = await requestEarn("POST", programPath(program.id, "/withdrawals"), {
        requestId: "0b1f2c3d-4e5a-4b6c-8d9e-0f1a2b3c4d5e",
        token: "usdc",
        destinationAddress: SOLANA_DESTINATION,
      });

      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });

    it("still 503s without credentials rather than inventing a liquidity figure", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      const preview = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "previewPortfolioWithdrawal");
      env.GROUND_SANDBOX_API_KEY = undefined;

      const res = await requestEarn("POST", programPath(program.id, "/withdrawal-preview"), {
        token: "usdc",
      });

      expect(res.status).toBe(503);
      expect(preview).not.toHaveBeenCalled();
    });
  });

  // The provider dedupes a withdrawal on its request id, and since PRO-1628
  // that same derived id also anchors the SDP-side intent row — a two-layer
  // defence. Every case here exists to keep the id stable across attempts and
  // to prove a replay never reaches the provider as a second create.
  describe("withdrawal idempotency", () => {
    const withdrawalBody = (extra: Record<string, unknown> = {}) => ({
      amountUsd: "10.00",
      token: "usdc",
      destinationAddress: SOLANA_DESTINATION,
      ...extra,
    });

    it("resolves a caller-key retry from the ledger: one provider create, replay served live", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
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
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: callerKey })
      );
      const retry = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
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
      const program = await seedProgramWallet();
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
        programPath(program.id, "/withdrawals"),
        withdrawalBody({ requestId: shared })
      );

      expect(res.status).toBe(201);
      const sent = createWithdrawal.mock.calls[0]?.[1]?.requestId;
      expect(sent).toBe(deriveProviderRequestId(["earn_program_withdrawal", WALLET_REF], shared));
      // A different program wallet — another org, or another program of this
      // org since PRO-1670 — cannot reach it.
      expect(sent).not.toBe(
        deriveProviderRequestId(["earn_program_withdrawal", "another-org-wallet"], shared)
      );
    });

    it("re-drives a crash-window retry with the SAME derived key from one Idempotency-Key", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      // First attempt: the provider call dies after the intent row was
      // written (network blip, process crash — the ref-less window).
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(WITHDRAWAL);

      const headers = { "Idempotency-Key": "checkout-9f2b" };
      const first = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
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
        programPath(program.id, "/withdrawals"),
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
      const program = await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      await requestEarn("POST", programPath(program.id, "/withdrawals"), withdrawalBody(), {
        "Idempotency-Key": "payout-a",
      });
      await requestEarn("POST", programPath(program.id, "/withdrawals"), withdrawalBody(), {
        "Idempotency-Key": "payout-b",
      });

      const [a, b] = createWithdrawal.mock.calls;
      expect(a?.[1]?.requestId).not.toBe(b?.[1]?.requestId);
    });

    it("refuses a withdrawal carrying both key sources", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      // The trap this guards: a retry layer that preserves headers while the
      // request layer mints a fresh body id per attempt keeps Idempotency-Key
      // stable and varies requestId. Any precedence rule would follow the
      // varying one and book a SECOND withdrawal, so refuse the ambiguity.
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
      await seedAuth();
      const program = await seedProgramWallet();
      const createWithdrawal = vi
        .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValue(WITHDRAWAL);

      const res = await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        withdrawalBody()
      );

      // Refusing beats accepting: a server-minted random id is fresh per
      // attempt, so it would turn a retry into a second payout.
      expect(res.status).toBe(400);
      expect(createWithdrawal).not.toHaveBeenCalled();
    });
  });

  it("rejects destinations that are not base58 Solana addresses", async () => {
    await seedAuth();
    const program = await seedProgramWallet();
    const createWithdrawal = vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal");

    const res = await requestEarn("POST", programPath(program.id, "/withdrawals"), {
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
    const program = await seedProgramWallet();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
      WITHDRAWAL
    );

    const res = await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody());
    expect(res.status).toBe(201);

    const [row] = await readLedgerRows();
    expect(row?.id).toMatch(/^earn_program_withdrawal_/);
    expect(row?.status).toBe("processing");
    expect(row?.provider).toBe("ground");
    expect(row?.wallet_id).toBe(program.id);
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
    const program = await seedProgramWallet();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody());
    expect(first.status).toBe(201);

    // An idempotency key names ONE intent; changing the payload under it is a
    // conflict — answered by SDP without touching the provider.
    const conflicting = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
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
    const program = await seedProgramWallet();
    const createWithdrawal = vi
      .spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
      .mockResolvedValue(WITHDRAWAL);
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue(WITHDRAWAL);

    const first = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({ amountUsd: "10.00" })
    );
    // The provider wire sends amountUsd as a JSON number, so '10' IS '10.00'
    // to Ground — SDP's fingerprint must replay it, not 409 it.
    const retry = await requestEarn(
      "POST",
      programPath(program.id, "/withdrawals"),
      createBody({ amountUsd: "10" })
    );

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("persists provider observations from the withdrawal detail poll", async () => {
    await seedAuth();
    const program = await seedProgramWallet();
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

    await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody());
    const res = await requestEarn(
      "GET",
      programPath(program.id, `/withdrawals/${WITHDRAWAL.withdrawalRef}`)
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
    const program = await seedProgramWallet();
    vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "getPortfolioWithdrawal").mockResolvedValue({
      ...WITHDRAWAL,
      withdrawalRef: "wd_pre_ledger",
    });

    const res = await requestEarn("GET", programPath(program.id, "/withdrawals/wd_pre_ledger"));

    expect(res.status).toBe(200);
    await expect(readLedgerRows()).resolves.toHaveLength(0);
  });

  it("404s a foreign organization's withdrawal ref BEFORE any provider call (BOLA guard)", async () => {
    await seedAuth();
    const program = await seedProgramWallet();
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
      providerWalletRef: "9a35f56f-deeb-478f-8c7c-4d2b6d8f0e32",
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

    const res = await requestEarn("GET", programPath(program.id, "/withdrawals/wd_victim_org"));

    expect(res.status).toBe(404);
    expect(getWithdrawal).not.toHaveBeenCalled();
  });

  describe("GET /programs/:programId/withdrawals — the ledger list", () => {
    it("returns the house list envelope from the ledger, newest first", async () => {
      await seedAuth();
      const program = await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal")
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_a" })
        .mockResolvedValueOnce({ ...WITHDRAWAL, withdrawalRef: "wd_b", status: "completed" });
      await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        createBody({ requestId: crypto.randomUUID(), amountUsd: "10.00" })
      );
      await requestEarn(
        "POST",
        programPath(program.id, "/withdrawals"),
        createBody({ requestId: crypto.randomUUID(), amountUsd: "20.00" })
      );

      const res = await requestEarn("GET", programPath(program.id, "/withdrawals"));

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
        programPath(program.id, "/withdrawals?page=2&pageSize=1")
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
      const program = await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
        WITHDRAWAL
      );
      await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody());

      // Pull the provider's credentials entirely: live reads break…
      env.GROUND_SANDBOX_API_KEY = undefined;
      const live = await requestEarn("GET", programPath(program.id));
      expect(live.status).toBe(503);

      // …but the ledger keeps answering. History must outlive credentials.
      const list = await requestEarn("GET", programPath(program.id, "/withdrawals"));
      expect(list.status).toBe(200);
      const body = (await list.json()) as { data: { total: number } };
      expect(body.data.total).toBe(1);
    });

    it("returns 404 for a program id that does not exist", async () => {
      await seedAuth();

      const res = await requestEarn(
        "GET",
        programPath("earn_provider_wallet_missing", "/withdrawals")
      );

      expect(res.status).toBe(404);
    });

    it("never serves the sandbox ledger to a production-project session", async () => {
      await seedAuth();
      await seedSessionAuth();
      const program = await seedProgramWallet();
      vi.spyOn(EARN_PROVIDER_CLIENTS.ground, "createPortfolioWithdrawal").mockResolvedValue(
        WITHDRAWAL
      );
      await requestEarn("POST", programPath(program.id, "/withdrawals"), createBody());

      // The program id resolves through (organization, environment), so the
      // sandbox program — and therefore its wallet-scoped ledger — is
      // structurally unreachable from a production session.
      const res = await requestEarnAsSession(
        "GET",
        programPath(program.id, "/withdrawals"),
        TEST_PRODUCTION_PROJECT.id
      );

      expect(res.status).toBe(404);
    });
  });
});
