import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const buildExternalWalletDepositTransaction = vi.hoisted(() => vi.fn());
const buildExternalWalletWithdrawalTransaction = vi.hoisted(() => vi.fn());
const submitExternalWalletDeposit = vi.hoisted(() => vi.fn());
const submitExternalWalletWithdrawal = vi.hoisted(() => vi.fn());
const surfacingEnabled = vi.hoisted(() => ({ value: true }));

vi.mock("@/services/earn/vault-external-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-external-wallet.service")>()),
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
}));

vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => surfacingEnabled.value,
}));

/**
 * The external-wallet (caller-signed) routes — the gates, and the ADR 0002
 * gate ASYMMETRY between them (PRO-1722).
 *
 * The deposit BUILD takes the full money-in stack (environment capability,
 * surfacing, entitlement, catalogue admission); the withdrawal BUILD takes
 * only 404-scoping and must keep working with every one of those gates
 * hostile — the "exit safety" describe proves the contrast under identical
 * conditions. Signature verification, replay and consumption semantics live
 * in `services/earn/vault-external-wallet.service.test.ts`; here the service
 * is mocked and the routing contract is the subject.
 */

const TEST_ORG = { id: "org_earn_ext", name: "Earn External Org", slug: "earn-ext" };
const TEST_PROJECT = { id: "prj_test_earn_ext", slug: "test-earn-ext-project" };
const TEST_PRODUCTION_PROJECT = { id: "prj_test_earn_ext_prod", slug: "test-earn-ext-prod" };
const TEST_USER = { id: "usr_earn_ext", email: "earn-ext@example.com" };
const TEST_API_KEY = { id: "key_earn_ext", raw: "sk_test_earn_ext", prefix: "sk_test_ear" };
const PROD_API_KEY = { id: "key_earn_ext_prod", raw: "sk_live_earn_ext", prefix: "sk_live_ear" };

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
const PROD_CACHED_API_KEY: CachedApiKey = {
  ...TEST_CACHED_API_KEY,
  id: PROD_API_KEY.id,
  projectId: TEST_PRODUCTION_PROJECT.id,
  environment: "production",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

async function seedAuth(options: { entitled?: boolean } = {}): Promise<void> {
  const entitled = options.entitled ?? true;
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, prodKeyHash, PROD_CACHED_API_KEY);

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
        entitled ? JSON.stringify({ providerOverrides: { earn: { kamino: true } } }) : "{}"
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Prod Project', ?, 'production', 'active', ?)`
      )
      .bind(TEST_PRODUCTION_PROJECT.id, TEST_ORG.id, TEST_PRODUCTION_PROJECT.slug, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Earn Ext Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        keyHash
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Earn Ext Prod Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        PROD_API_KEY.id,
        TEST_ORG.id,
        TEST_PRODUCTION_PROJECT.id,
        TEST_USER.id,
        PROD_API_KEY.prefix,
        prodKeyHash
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

async function seedExternalWalletPosition(
  overrides: Partial<{
    projectId: string | null;
    ownerAddress: string;
    environment: string;
  }> = {}
): Promise<string> {
  const id = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, ?, 'kamino', 'vault_direct', ?, ?, ?, ?, 'Exit Vault', sdp_iso_now())`
    )
    .bind(
      id,
      TEST_ORG.id,
      overrides.projectId === undefined ? TEST_PROJECT.id : overrides.projectId,
      overrides.environment ?? "sandbox",
      overrides.ownerAddress ?? OWNER,
      VAULT,
      SHARE_MINT,
      USDC_MINT
    )
    .run();
  return id;
}

async function seedCustodyPosition(): Promise<string> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_earn_ext', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_earn_ext', 'cfg_earn_ext', 'privy_earn_ext', ?, 'active')`
      )
      .bind(OWNER),
  ]);
  const id = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'cwlt_earn_ext', ?, ?, ?, 'Treasury Vault', sdp_iso_now())`
    )
    .bind(id, TEST_ORG.id, TEST_PROJECT.id, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  return id;
}

function builtRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `earn_external_wallet_transaction_${crypto.randomUUID()}`,
    organization_id: TEST_ORG.id,
    project_id: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "kamino",
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

function submitResult(overrides: Record<string, unknown> = {}) {
  const movementId = `earn_movement_${crypto.randomUUID()}`;
  return {
    position: { id: "earn_position_ext_test" },
    movement: {
      id: movementId,
      position_id: "earn_position_ext_test",
      provider: "kamino",
      vault_address: VAULT,
      direction: "deposit",
      status: "submitted",
      signature: `sig_${crypto.randomUUID()}`,
      owner_address: OWNER,
      amount_requested: "25",
      denomination: USDC_MINT,
      failure_reason: null,
      created_at: new Date().toISOString(),
      confirmed_at: null,
      settled_at: null,
      ...overrides,
    },
    replayed: false,
  };
}

function post(
  path: string,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string | null; apiKey?: string } = {}
) {
  return app.request(
    `/v1/earn/external-wallet/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey ?? TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey == null ? {} : { "Idempotency-Key": options.idempotencyKey }),
      },
      body: JSON.stringify(body),
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  surfacingEnabled.value = true;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  buildExternalWalletDepositTransaction.mockResolvedValue({ kind: "built", built: builtRow() });
  buildExternalWalletWithdrawalTransaction.mockResolvedValue(
    builtRow({
      direction: "withdrawal",
      position_id: "earn_position_ext_test",
      denomination: SHARE_MINT,
      amount_requested: "10",
    })
  );
  submitExternalWalletDeposit.mockResolvedValue(submitResult());
  submitExternalWalletWithdrawal.mockResolvedValue(
    submitResult({ direction: "withdrawal", denomination: SHARE_MINT, amount_requested: "10" })
  );
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  vi.restoreAllMocks();
});

describe("POST /v1/earn/external-wallet/deposit-transactions — money-in gates", () => {
  it("builds against a resolved, admitted strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { transaction: Record<string, unknown> };
    };
    expect(body.data.transaction.transactionId).toMatch(/^earn_external_wallet_transaction_/);
    expect(body.data.transaction.ownerAddress).toBe(OWNER);
    expect(body.data.transaction.amount).toBe("25");
    expect(body.data.transaction.lastValidBlockHeight).toBe("361");
    expect(buildExternalWalletDepositTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        environment: "sandbox",
        provider: "kamino",
        providerReference: strategy.provider_reference,
        ownerAddress: OWNER,
        amount: "25",
      })
    );
  });

  it("404s an unknown strategy", async () => {
    await seedAuth();
    const res = await post("deposit-transactions", {
      strategyId: "strat_missing",
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(res.status).toBe(404);
  });

  describe("swap-funded builds", () => {
    // Devnet USDG — a supported swap-source mint on sandbox's cluster.
    const SOURCE_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";
    const swapLeg = {
      instructions: [],
      lookupTableAddresses: [],
      sourceAmount: "25",
      quotedAmount: "24.99",
      minOutAmount: "24.8",
      priceImpactPct: "0.0001",
      routeLabels: ["Whirlpool"],
      slippageBps: 50,
    };

    it("passes a validated swap request through and reports the swap on the wire", async () => {
      await seedAuth();
      const strategy = await seedStrategy();
      buildExternalWalletDepositTransaction.mockResolvedValue({
        kind: "built",
        built: builtRow({ amount_requested: "24.8" }),
        swap: swapLeg,
      });

      const res = await post("deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: OWNER,
        amount: "25",
        sourceTokenMint: SOURCE_MINT,
      });

      expect(res.status).toBe(200);
      expect(buildExternalWalletDepositTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          amount: "25",
          swap: { sourceTokenMint: SOURCE_MINT, slippageBps: 2 },
        })
      );
      const body = (await res.json()) as {
        data: { transaction: { amount: string; swap: Record<string, unknown> } };
      };
      expect(body.data.transaction.amount).toBe("24.8");
      expect(body.data.transaction.swap).toMatchObject({
        sourceTokenMint: SOURCE_MINT,
        sourceAmount: "25",
        depositAmount: "24.8",
        quotedAmount: "24.99",
        slippageBps: 50,
      });
    });

    it("treats a source equal to the strategy's own deposit mint as an unswapped build", async () => {
      await seedAuth();
      const strategy = await seedStrategy();

      const res = await post("deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: OWNER,
        amount: "25",
        sourceTokenMint: USDC_MINT,
      });

      expect(res.status).toBe(200);
      const input = buildExternalWalletDepositTransaction.mock.calls[0]?.[1];
      expect(input.swap).toBeUndefined();
    });

    it("enforces the tolerance bounds at the schema: 1..500 bps", async () => {
      await seedAuth();
      const strategy = await seedStrategy();

      for (const swapSlippageBps of [0, 501]) {
        const res = await post("deposit-transactions", {
          strategyId: strategy.id,
          ownerAddress: OWNER,
          amount: "25",
          sourceTokenMint: SOURCE_MINT,
          swapSlippageBps,
        });
        expect(res.status).toBe(400);
      }
      expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();

      // The bounds are inclusive: both edges build.
      for (const swapSlippageBps of [1, 500]) {
        const res = await post("deposit-transactions", {
          strategyId: strategy.id,
          ownerAddress: OWNER,
          amount: "25",
          sourceTokenMint: SOURCE_MINT,
          swapSlippageBps,
        });
        expect(res.status).toBe(200);
      }
      expect(buildExternalWalletDepositTransaction).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          swap: { sourceTokenMint: SOURCE_MINT, slippageBps: 500 },
        })
      );
    });

    it("refuses an unsupported source mint before any build", async () => {
      await seedAuth();
      const strategy = await seedStrategy();

      const res = await post("deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: OWNER,
        amount: "25",
        sourceTokenMint: OWNER,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("not a supported swap funding token");
      expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();
    });

    it("answers the split contract when the composed transaction cannot fit", async () => {
      await seedAuth();
      const strategy = await seedStrategy();
      buildExternalWalletDepositTransaction.mockResolvedValue({
        kind: "swap_required",
        swap: swapLeg,
        swapTransaction: {
          bytes: Uint8Array.from([1, 2, 3]),
          lastValidBlockHeight: "361",
        },
      });

      const res = await post("deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: OWNER,
        amount: "25",
        // The floor must SURVIVE the split: production requires one on the
        // follow-up build, and elsewhere a floor-less rebuild selects the
        // legacy unprotected deposit instruction.
        minSharesOut: "24.5",
        sourceTokenMint: SOURCE_MINT,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          requiresSeparateSwap: boolean;
          swap: { transaction: string; depositAmount: string };
          followUp: { strategyId: string; amount: string; minSharesOut?: string };
        };
      };
      expect(body.data.requiresSeparateSwap).toBe(true);
      expect(body.data.swap.transaction).toBe(Buffer.from([1, 2, 3]).toString("base64"));
      expect(body.data.swap.depositAmount).toBe("24.8");
      expect(body.data.followUp).toEqual({
        strategyId: strategy.id,
        amount: "24.8",
        minSharesOut: "24.5",
      });
    });

    it("omits the follow-up floor only when the original request carried none", async () => {
      await seedAuth();
      const strategy = await seedStrategy();
      buildExternalWalletDepositTransaction.mockResolvedValue({
        kind: "swap_required",
        swap: swapLeg,
        swapTransaction: {
          bytes: Uint8Array.from([1, 2, 3]),
          lastValidBlockHeight: "361",
        },
      });

      const res = await post("deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: OWNER,
        amount: "25",
        sourceTokenMint: SOURCE_MINT,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { followUp: Record<string, unknown> };
      };
      expect(body.data.followUp).toEqual({ strategyId: strategy.id, amount: "24.8" });
    });
  });

  it("refuses a paused strategy (catalogue admission)", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ status: "paused" });
    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("paused");
  });

  it("refuses a strategy whose host cluster is not fundable here", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });
    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an un-surfaced provider", async () => {
    await seedAuth();
    surfacingEnabled.value = false;
    const strategy = await seedStrategy();
    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(res.status).toBe(403);
    expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();
  });

  it("refuses an unentitled organization", async () => {
    await seedAuth({ entitled: false });
    const strategy = await seedStrategy();
    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(res.status).toBe(403);
    expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();
  });

  it("refuses an invalid ownerAddress at the schema", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const res = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: "not-an-address",
      amount: "25",
    });
    expect(res.status).toBe(400);
  });

  it("keeps production closed by the environment capability", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ environment: "production" });
    const res = await post(
      "deposit-transactions",
      { strategyId: strategy.id, ownerAddress: OWNER, amount: "25", minSharesOut: "1" },
      { apiKey: PROD_API_KEY.raw }
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("not available in production");
  });
});

describe("POST /v1/earn/external-wallet/deposits — the submit contract", () => {
  it("requires the Idempotency-Key header", async () => {
    await seedAuth();
    const res = await post("deposits", { transactionId: "earn_ext_tx", signedTransaction: "AQ==" });
    expect(res.status).toBe(400);
    expect(submitExternalWalletDeposit).not.toHaveBeenCalled();
  });

  it("refuses Dry-Run: these routes have no policy evaluation to preview", async () => {
    await seedAuth();
    const res = await app.request(
      "/v1/earn/external-wallet/deposits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "Dry-Run": "true",
        },
        body: JSON.stringify({ transactionId: "earn_ext_tx", signedTransaction: "AQ==" }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(submitExternalWalletDeposit).not.toHaveBeenCalled();
  });

  it("rejects a body requestId", async () => {
    await seedAuth();
    const res = await post(
      "deposits",
      {
        transactionId: "earn_ext_tx",
        signedTransaction: "AQ==",
        requestId: crypto.randomUUID(),
      },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-base64 signedTransaction at the schema", async () => {
    await seedAuth();
    const res = await post(
      "deposits",
      { transactionId: "earn_ext_tx", signedTransaction: "not base64!!" },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(res.status).toBe(400);
  });

  it("records the submit and answers the movement in ledger vocabulary", async () => {
    await seedAuth();
    const key = crypto.randomUUID();
    const res = await post(
      "deposits",
      { transactionId: "earn_ext_tx", signedTransaction: "AQ==" },
      { idempotencyKey: key }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit: Record<string, unknown> } };
    expect(body.data.deposit.status).toBe("submitted");
    expect(body.data.deposit.ownerAddress).toBe(OWNER);
    expect(body.data.deposit.replayed).toBe(false);
    expect(submitExternalWalletDeposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        environment: "sandbox",
        transactionId: "earn_ext_tx",
        signedTransaction: "AQ==",
        requestId: key,
      })
    );
  });
});

describe("POST /v1/earn/external-wallet/withdrawal-transactions — scoping", () => {
  it("404s an unknown position", async () => {
    await seedAuth();
    const res = await post("withdrawal-transactions", {
      positionId: "earn_position_missing",
      shares: "10",
    });
    expect(res.status).toBe(404);
  });

  it("404s a custody position: the treasury exit is a different surface", async () => {
    await seedAuth();
    const positionId = await seedCustodyPosition();
    const res = await post("withdrawal-transactions", { positionId, shares: "10" });
    expect(res.status).toBe(404);
    expect(buildExternalWalletWithdrawalTransaction).not.toHaveBeenCalled();
  });

  it("404s a sibling project's position: the wallet is project-scoped", async () => {
    await seedAuth();
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES ('prj_earn_ext_sibling', ?, 'Sibling', 'earn-ext-sibling', 'sandbox', 'active', ?)`
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();
    const positionId = await seedExternalWalletPosition({ projectId: "prj_earn_ext_sibling" });
    const res = await post("withdrawal-transactions", { positionId, shares: "10" });
    expect(res.status).toBe(404);
  });

  it("builds the exit from the recorded position facts", async () => {
    await seedAuth();
    const positionId = await seedExternalWalletPosition();
    const res = await post("withdrawal-transactions", { positionId, shares: "10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { transaction: Record<string, unknown> } };
    // The response names the RESOLVED position, not whatever the service row
    // says: the route is the scoping authority.
    expect(body.data.transaction.positionId).toBe(positionId);
    expect(body.data.transaction.shares).toBe("10");
    expect(buildExternalWalletWithdrawalTransaction).toHaveBeenCalledWith(
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
});

describe("exit safety (ADR 0002): the exit outlives every money-in gate", () => {
  it("builds the exit for an unentitled org while the provider is un-surfaced and the strategy is paused", async () => {
    await seedAuth({ entitled: false });
    surfacingEnabled.value = false;
    await seedStrategy({ status: "paused" });
    const positionId = await seedExternalWalletPosition();

    const exit = await post("withdrawal-transactions", { positionId, shares: "10" });
    expect(exit.status).toBe(200);

    // The CONTRAST under identical conditions: the deposit build is refused.
    const strategy = await seedStrategy();
    const deposit = await post("deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: OWNER,
      amount: "25",
    });
    expect(deposit.status).toBe(403);
  });

  it("submits the signed exit while the provider is un-surfaced", async () => {
    await seedAuth({ entitled: false });
    surfacingEnabled.value = false;
    const res = await post(
      "withdrawals",
      { transactionId: "earn_ext_tx", signedTransaction: "AQ==" },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { withdrawal: Record<string, unknown> } };
    expect(body.data.withdrawal.status).toBe("submitted");
    expect(body.data.withdrawal.denomination).toBe(SHARE_MINT);
  });
});
