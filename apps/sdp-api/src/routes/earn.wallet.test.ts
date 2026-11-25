import { JupiterLendVaultDirectClient } from "@sdp/jupiter-lend/client";
import { hashString } from "@sdp/payments/hash";
import * as providerAccess from "@sdp/types/provider-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { EarnStrategyRow, UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import type { EarnWalletTransactionRow } from "@/db/repositories/earn-wallet-transactions.repository";
import { app } from "@/index";
import { RATE_LIMIT_WINDOW_MS } from "@/middleware/rate-limit";
import * as redisStores from "@/runtime/kv-redis";
import * as executionRegistry from "@/services/earn/execution-registry";
import * as vaultWallet from "@/services/earn/vault-wallet.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { recordCallScopes } from "@/test/helpers/cluster-scope";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, readRateLimitCount, seedRateLimit } from "@/test/mocks/kv";

let spies: ReturnType<typeof spyOnCollaborators>;
const surfacingEnabled = { value: true };
const rateLimitStoreDown = { value: false };

function spyOnCollaborators() {
  const client = new JupiterLendVaultDirectClient(
    async () => {
      throw new Error("Unexpected provider RPC lookup");
    },
    async () => {
      throw new Error("Unexpected provider execution");
    }
  );
  vi.spyOn(executionRegistry, "resolveVaultWithdrawClient").mockReturnValue(client);
  vi.spyOn(executionRegistry, "resolveEarnExecutionClient").mockReturnValue(client);
  vi.spyOn(executionRegistry, "isEarnDirectWithdrawalConfigured").mockReturnValue(true);
  vi.spyOn(providerAccess, "isEarnProviderSurfaced").mockImplementation(
    () => surfacingEnabled.value
  );

  const stores = redisStores.createKVStoreSet(env);
  const admit = stores.rateLimits.admitSlidingWindow.bind(stores.rateLimits);
  vi.spyOn(stores.rateLimits, "admitSlidingWindow").mockImplementation(async (...args) => {
    if (rateLimitStoreDown.value) throw new Error("counter store down");
    return admit(...args);
  });
  vi.spyOn(redisStores, "createKVStoreSet").mockReturnValue(stores);

  return {
    deposit: vi.spyOn(vaultWallet, "buildWalletDepositTransaction"),
    withdrawal: vi.spyOn(vaultWallet, "buildWalletWithdrawalTransaction"),
    quote: vi.spyOn(client, "quoteVaultWithdrawal"),
  };
}

// Pin admission behavior, not the editorial address shelf chosen for a release.
vi.mock("@/routes/earn/handlers/curation", async (original) => ({
  ...(await original<typeof import("@/routes/earn/handlers/curation")>()),
  CURATED_VAULTS: {},
  HIDDEN_VAULTS: {},
  HIDDEN_STRATEGY_TERMS: [],
}));

/**
 * The wallet (caller-signed) routes — the gates, and the ADR 0002
 * gate ASYMMETRY between them (PRO-1722).
 *
 * The deposit BUILD takes the full money-in stack (environment capability,
 * surfacing, entitlement, catalogue admission); the withdrawal BUILD takes
 * only 404-scoping and must keep working with every one of those gates
 * hostile — the "exit safety" describe proves the contrast under identical
 * conditions. Signature verification, replay and consumption semantics live
 * in `services/earn/vault-wallet.service.test.ts`; here the service
 * is mocked and the routing contract is the subject.
 */

const TEST_ORG = { id: "org_earn_ext", name: "Earn External Org", slug: "earn-ext" };
const TEST_PROJECT = { id: "prj_test_earn_ext", slug: "test-earn-ext-project" };
const TEST_PRODUCTION_PROJECT = { id: "prj_test_earn_ext_prod", slug: "test-earn-ext-prod" };
const TEST_USER = { id: "usr_earn_ext", email: "earn-ext@example.com" };
const TEST_API_KEY = { id: "key_earn_ext", raw: "sk_test_earn_ext", prefix: "sk_test_ear" };
const PROD_API_KEY = { id: "key_earn_ext_prod", raw: "sk_live_earn_ext", prefix: "sk_live_ear" };

const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};
const PROD_CACHED_API_KEY: SeededApiKey = {
  ...TEST_SEEDED_API_KEY,
  id: PROD_API_KEY.id,
  projectId: TEST_PRODUCTION_PROJECT.id,
  environment: "production",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

async function seedAuth(options: { entitled?: boolean } = {}): Promise<void> {
  const entitled = options.entitled ?? true;
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);
  const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, prodKeyHash, PROD_CACHED_API_KEY);

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
        entitled
          ? JSON.stringify({ providerOverrides: { earn: { kamino: true, jupiter_lend: true } } })
          : "{}"
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, 'Earn Ext Test Key', ?, ?, ?, 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        keyHash,
        ALL_API_KEY_GRANTS
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, 'Earn Ext Prod Key', ?, ?, ?, 'active')`
      )
      .bind(
        PROD_API_KEY.id,
        TEST_ORG.id,
        TEST_PRODUCTION_PROJECT.id,
        TEST_USER.id,
        PROD_API_KEY.prefix,
        prodKeyHash,
        ALL_API_KEY_GRANTS
      ),
  ]);
}

async function seedStrategy(
  overrides: Partial<UpsertEarnStrategyInput> = {}
): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Test USDC Vault",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [USDC_MINT],
    shareMint: SHARE_MINT,
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
  if (!strategy) throw new Error("Failed to seed earn strategy");
  return strategy;
}

async function seedWalletPosition(
  overrides: Partial<{
    projectId: string | null;
    ownerAddress: string;
    environment: string;
    provider: string;
  }> = {}
): Promise<string> {
  const id = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, ?, ?, 'vault_direct', ?, ?, ?, ?, 'Exit Vault', sdp_iso_now())`
    )
    .bind(
      id,
      TEST_ORG.id,
      overrides.projectId === undefined ? TEST_PROJECT.id : overrides.projectId,
      overrides.environment ?? "sandbox",
      overrides.provider ?? "kamino",
      overrides.ownerAddress ?? OWNER,
      VAULT,
      SHARE_MINT,
      USDC_MINT
    )
    .run();
  return id;
}

function builtRow(overrides: Partial<EarnWalletTransactionRow> = {}): EarnWalletTransactionRow {
  return {
    id: `earn_wallet_transaction_${crypto.randomUUID()}`,
    organization_id: TEST_ORG.id,
    project_id: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "kamino",
    strategy_id: null,
    custody_wallet_id: null,
    fee_mode: "wallet",
    direction: "deposit",
    owner_address: OWNER,
    vault_address: VAULT,
    token_mint: USDC_MINT,
    share_mint: SHARE_MINT,
    label: "Test USDC Vault",
    position_id: null,
    denomination: USDC_MINT,
    amount_requested: "25",
    min_shares_out: null,
    creates_share_account: true,
    fee_payer: null,
    share_ata_rent_funder: null,
    unsigned_transaction: "AQ==",
    last_valid_block_height: "361",
    movement_id: null,
    consumed_at: null,
    created_by: null,
    initiated_by_key_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  surfacingEnabled.value = true;
  rateLimitStoreDown.value = false;
  spies = spyOnCollaborators();
  await seedTestDatabase(env);
  await clearKVStores(env);
  spies.deposit.mockResolvedValue({ kind: "built", built: builtRow() });
  spies.withdrawal.mockResolvedValue(
    builtRow({
      direction: "withdrawal",
      position_id: "earn_position_ext_test",
      denomination: SHARE_MINT,
      amount_requested: "10",
    })
  );
  spies.quote.mockResolvedValue({
    assetsOut: "9.95",
    assetDecimals: 6,
    blockingIssues: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Legacy provider-build cases moved to the shared preparation contract. The
 * provider service suite retains message, swap, fee-payer and simulation checks. */
async function prepareDeposit(
  body: Record<string, unknown>,
  options: { idempotencyKey?: string; apiKey?: string } = {}
) {
  return app.request(
    "/v1/earn/deposit",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey ?? TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    env
  );
}
function depositBody(strategyId: string, overrides: Record<string, unknown> = {}) {
  return {
    strategyId,
    source: { ownerAddress: OWNER },
    amount: { mint: USDC_MINT, value: "25" },
    ...overrides,
  };
}

async function prepareWithdrawal(body: Record<string, unknown>, options: { apiKey?: string } = {}) {
  return app.request(
    "/v1/earn/withdraw",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey ?? TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function withdrawalBody(positionId: string, overrides: Record<string, unknown> = {}) {
  return { positionId, amount: { kind: "shares", value: "10" }, ...overrides };
}

describe("core deposit preparation replaces legacy deposit builds", () => {
  it("prepares one scoped operation and never submits the transaction", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const scopes = recordCallScopes(spies.deposit);
    const response = await prepareDeposit(depositBody(strategy.id));
    expect(response.status, await response.clone().text()).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        operation: {
          kind: "earn.deposit",
          status: "prepared",
          intent: {
            strategyId: strategy.id,
            source: { ownerAddress: OWNER },
            amount: { mint: USDC_MINT, value: "25" },
          },
          nextAction: {
            type: "sign_transaction",
            transaction: "AQ==",
            lastValidBlockHeight: "361",
          },
          terms: { fees: null },
          version: 1,
        },
      },
    });
    expect(spies.deposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "kamino",
        providerReference: strategy.provider_reference,
        ownerAddress: OWNER,
        amount: "25",
      })
    );
    expect(scopes).toEqual([
      expect.objectContaining({ projectId: TEST_PROJECT.id, environment: "sandbox" }),
    ]);
  });

  it("replays prepared intent without rebuilding or substituting terms", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const idempotencyKey = crypto.randomUUID();
    const first = await prepareDeposit(depositBody(strategy.id), { idempotencyKey });
    const initial = await first.json();
    const second = await prepareDeposit(depositBody(strategy.id), { idempotencyKey });
    expect((await second.json()).data.operation.id).toBe(initial.data.operation.id);
    expect(spies.deposit).toHaveBeenCalledTimes(1);
  });

  it("requires idempotency before provider preparation", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const response = await app.request(
      "/v1/earn/deposit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(depositBody(strategy.id)),
      },
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(spies.deposit).not.toHaveBeenCalled();
  });

  it.each(["paused", "deprecated"] as const)(
    "refuses a %s strategy before building",
    async (status) => {
      await seedAuth();
      const strategy = await seedStrategy({ status });
      const response = await prepareDeposit(depositBody(strategy.id));
      expect(response.status).toBe(400);
      expect(spies.deposit).not.toHaveBeenCalled();
    }
  );

  it("refuses an unknown or wrong-cluster strategy before building", async () => {
    await seedAuth();
    expect((await prepareDeposit(depositBody("missing"))).status).toBe(404);
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });
    expect((await prepareDeposit(depositBody(strategy.id))).status).toBe(400);
    expect(spies.deposit).not.toHaveBeenCalled();
  });

  it.each(["surfacing", "entitlement"] as const)("rechecks provider %s", async (gate) => {
    await seedAuth({ entitled: gate !== "entitlement" });
    surfacingEnabled.value = gate !== "surfacing";
    const strategy = await seedStrategy();
    expect((await prepareDeposit(depositBody(strategy.id))).status).toBe(
      gate === "surfacing" ? 400 : 403
    );
    expect(spies.deposit).not.toHaveBeenCalled();
  });

  it.each([
    { source: { ownerAddress: "invalid" } },
    { amount: { mint: USDC_MINT, value: "0" } },
    { amount: { mint: USDC_MINT, value: "1e6" } },
    { slippageBps: 501 },
    { feePayer: "invalid" },
  ])("refuses malformed economic input before provider work: %j", async (invalid) => {
    await seedAuth();
    const strategy = await seedStrategy();
    expect((await prepareDeposit(depositBody(strategy.id, invalid))).status).toBe(400);
    expect(spies.deposit).not.toHaveBeenCalled();
  });

  it("preserves a valid partner payer in its immutable intent and build", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const feePayer = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
    const response = await prepareDeposit(depositBody(strategy.id, { feePayer }));
    expect(response.status).toBe(202);
    expect((await response.json()).data.operation.intent.feePayer).toBe(feePayer);
    expect(spies.deposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ feePayer })
    );
  });
});

describe("core wallet withdrawal preparation", () => {
  it("refuses an exit body that names a strategy instead of a position", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const res = await prepareWithdrawal({
      strategyId: strategy.id,
      ownerAddress: OWNER,
      shares: "10",
    });

    expect(res.status).toBe(400);
    expect(spies.withdrawal).not.toHaveBeenCalled();
  });

  it("404s another project's position for withdrawal preparation", async () => {
    await seedAuth();
    const positionId = await seedWalletPosition();
    const response = await prepareWithdrawal(withdrawalBody(positionId), {
      apiKey: PROD_API_KEY.raw,
    });
    expect(response.status).toBe(404);
  });

  it("404s an unknown position", async () => {
    await seedAuth();
    const res = await prepareWithdrawal(withdrawalBody("earn_position_missing"));
    expect(res.status).toBe(404);
  });

  it("builds the exit from the recorded position facts", async () => {
    await seedAuth();
    const positionId = await seedWalletPosition();
    const res = await prepareWithdrawal(withdrawalBody(positionId));

    expect(res.status, await res.clone().text()).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      data: {
        operation: {
          intent: { kind: "earn.withdraw", positionId, amount: { kind: "shares", value: "10" } },
          nextAction: { type: "sign_transaction" },
        },
      },
    });
    expect(spies.withdrawal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        positionId,
        vaultAddress: VAULT,
        ownerAddress: OWNER,
        tokenMint: USDC_MINT,
        shareMint: SHARE_MINT,
        shareAtaRentFunder: null,
        shares: "10",
      })
    );
  });

  it("derives the provider's output floor from a live quote", async () => {
    await seedAuth();
    const positionId = await seedWalletPosition({ provider: "jupiter_lend" });

    const res = await prepareWithdrawal(withdrawalBody(positionId));

    expect(res.status, await res.clone().text()).toBe(202);
    expect(spies.withdrawal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minAmountOut: "9.94005" })
    );
    expect(await res.json()).toMatchObject({
      data: {
        operation: {
          terms: {
            estimate: { mint: USDC_MINT, value: "9.95" },
            minimum: { mint: USDC_MINT, value: "9.94005" },
          },
        },
      },
    });
  });

  it("applies the caller's tolerance to the same quoted output", async () => {
    await seedAuth();
    const positionId = await seedWalletPosition({ provider: "jupiter_lend" });

    const res = await prepareWithdrawal(withdrawalBody(positionId, { slippageBps: 250 }));

    expect(res.status, await res.clone().text()).toBe(202);
    expect(spies.withdrawal).toHaveBeenCalledTimes(1);
    expect(spies.withdrawal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minAmountOut: "9.70125" })
    );
  });
});

describe("exit safety (ADR 0002): the exit outlives every money-in gate", () => {
  it("builds the exit for an unentitled org while the provider is un-surfaced and the strategy is paused", async () => {
    await seedAuth({ entitled: false });
    surfacingEnabled.value = false;
    await seedStrategy({ status: "paused" });
    const positionId = await seedWalletPosition();

    const exit = await prepareWithdrawal(withdrawalBody(positionId));
    expect(exit.status, await exit.clone().text()).toBe(202);

    const strategy = await seedStrategy();
    const deposit = await prepareDeposit(depositBody(strategy.id));
    expect(deposit.status).toBe(400);
    expect(await deposit.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(spies.deposit).not.toHaveBeenCalled();
  });
});

/**
 * The keyed deposit BUILD is money-in against paid RPC (a simulation probe per
 * build, Jupiter on a swap-funded one), so it carries the same keyed meter as
 * core preparation (PRO-1994). The exit preparation carries none, and that
 * is load-bearing: `meteredQuota` fails closed, and a 5xx on the way out of a
 * position is what ADR 0002 exit safety rules out. See routes/earn/CLAUDE.md,
 * "Metered quotas".
 */
describe("metered quotas (PRO-1994): the deposit build is metered, the exit never is", () => {
  const ACTOR_SCOPE = `metered:earn-provider-read:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`;

  beforeEach(() => {
    const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    vi.spyOn(Date, "now").mockReturnValue(windowStart + RATE_LIMIT_WINDOW_MS / 2);
  });

  it.each([0, RATE_LIMIT_WINDOW_MS - 1])(
    "429s an exhausted keyed deposit build at window offset %i ms",
    async (offset) => {
      const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
      vi.mocked(Date.now).mockReturnValue(windowStart + offset);
      await seedAuth();
      const strategy = await seedStrategy();
      await seedRateLimit(env, ACTOR_SCOPE, 60);

      const res = await prepareDeposit(depositBody(strategy.id));

      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      // Refused before the RPC probe was paid for, which is the whole point.
      expect(spies.deposit).not.toHaveBeenCalled();
    }
  );

  it("admits a deposit when the previous bucket decays after rollover", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const windowEnd =
      Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS + RATE_LIMIT_WINDOW_MS;
    vi.mocked(Date.now).mockReturnValue(windowEnd - 1);
    await seedRateLimit(env, ACTOR_SCOPE, 60);
    vi.mocked(Date.now).mockReturnValue(windowEnd + 1);

    const res = await prepareDeposit(depositBody(strategy.id));

    expect(res.status, await res.clone().text()).toBe(202);
    expect(spies.deposit).toHaveBeenCalledTimes(1);
  });

  it("charges nothing for a keyed request the body validator refuses", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await prepareDeposit({
      strategyId: strategy.id,
      amount: { mint: USDC_MINT, value: "25" },
    });

    expect(res.status).toBe(400);
    // The org pool is shared: malformed requests must not be able to drain it.
    expect(await readRateLimitCount(env, ACTOR_SCOPE)).toBe(0);
    expect(await readRateLimitCount(env, `metered:earn-provider-read:org:${TEST_ORG.id}`)).toBe(0);
  });

  it("never lets an exhausted quota stand between the owner and its exit", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const positionId = await seedWalletPosition();
    // Both Earn quotas exhausted for this actor AND the whole organization.
    for (const quota of ["earn-provider-read", "earn-chain-read"]) {
      await seedRateLimit(env, `metered:${quota}:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`, 1000);
      await seedRateLimit(env, `metered:${quota}:org:${TEST_ORG.id}`, 1000);
    }

    const exit = await prepareWithdrawal(withdrawalBody(positionId));
    expect(exit.status, await exit.clone().text()).toBe(202);
    expect(spies.withdrawal).toHaveBeenCalledTimes(1);

    const deposit = await prepareDeposit(depositBody(strategy.id));
    expect(deposit.status).toBe(429);
  });

  it("a counter-store outage refuses the deposit build and never the exit", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const positionId = await seedWalletPosition();
    rateLimitStoreDown.value = true;

    const exit = await prepareWithdrawal(withdrawalBody(positionId));
    expect(exit.status, await exit.clone().text()).toBe(202);

    const deposit = await prepareDeposit(depositBody(strategy.id));
    expect(deposit.status).toBe(503);
    expect(await deposit.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(spies.deposit).not.toHaveBeenCalled();
  });
});
