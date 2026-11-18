import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { EarnStrategyRow, UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  createPostgresEarnExternalWalletTransactionsRepository,
  generateEarnExternalWalletTransactionId,
} from "@/db/repositories/earn-external-wallet-transactions.repository";
import {
  generateEarnMovementId,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import { app } from "@/index";
import { resetVaultExposureCacheForTesting } from "@/services/earn/vault-exposure";
import type { ExternalWalletDepositBuildInput } from "@/services/earn/vault-external-wallet.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const logEvent = vi.hoisted(() => vi.fn());
const build = vi.hoisted(() => vi.fn());
const exposureReadFailure = vi.hoisted(() => ({ current: null as Error | null }));
vi.mock("@/runtime/money-path-events", async (original) => ({
  ...(await original<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));
vi.mock("@/routes/earn/handlers/curation", async (original) => ({
  ...(await original<typeof import("@/routes/earn/handlers/curation")>()),
  CURATED_VAULTS: {},
  HIDDEN_VAULTS: {},
  HIDDEN_STRATEGY_TERMS: [],
}));
vi.mock("@/services/earn/vault-external-wallet.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-external-wallet.service")>()),
  buildExternalWalletDepositTransaction: build,
}));
vi.mock("@/db/repositories/earn-movements.repository", async (original) => {
  const actual = await original<typeof import("@/db/repositories/earn-movements.repository")>();
  return {
    ...actual,
    createPostgresEarnMovementsRepository: (
      ...args: Parameters<typeof actual.createPostgresEarnMovementsRepository>
    ) => {
      const repo = actual.createPostgresEarnMovementsRepository(...args);
      return {
        ...repo,
        sumVaultDepositExposure: (input: Parameters<typeof repo.sumVaultDepositExposure>[0]) => {
          if (exposureReadFailure.current !== null)
            return Promise.reject(exposureReadFailure.current);
          return repo.sumVaultDepositExposure(input);
        },
      };
    },
  };
});

const TEST_ORG = { id: "org_earn_cap", name: "Earn Cap Org", slug: "earn-cap" };
const OTHER_ORG = { id: "org_earn_cap_other", name: "Earn Cap Other Org", slug: "earn-cap-other" };
const TEST_PROJECT = { id: "prj_test_earn_cap", slug: "test-earn-cap-project" };
const OTHER_PROJECT = { id: "prj_test_earn_cap_other", slug: "test-earn-cap-other" };
const TEST_USER = { id: "usr_earn_cap", email: "earn-cap@example.com" };
const TEST_API_KEY = { id: "key_earn_cap", raw: "sk_test_earn_cap", prefix: "sk_test_ear" };
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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_OWNER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";
const CUSTODY_WALLET_ID = "cwlt_earn_cap";
/** The platform default's absolute ceiling, `DEFAULT_VAULT_EXPOSURE_CAP.maxAbsolute`. */
const DEFAULT_CEILING = "5000000";

let originalCapsEnforced: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  const settings = JSON.stringify({ providerOverrides: { earn: { kamino: true, veda: true } } });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'enterprise', 'active', ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, settings),
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, 'enterprise', 'active', ?)"
      )
      .bind(OTHER_ORG.id, OTHER_ORG.name, OTHER_ORG.slug, settings),
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
         VALUES (?, ?, 'Other Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(OTHER_PROJECT.id, OTHER_ORG.id, OTHER_PROJECT.slug, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, 'Earn Cap Test Key', ?, ?, ?, 'active')`
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
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_earn_cap', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_earn_cap', 'privy_earn_cap', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, WALLET_ADDRESS),
  ]);
}

async function seedStrategy(
  overrides: Partial<UpsertEarnStrategyInput> = {}
): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Capped USDC Vault",
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

/**
 * Another organization's external-wallet deposit into `vault`, still in
 * flight (`submitted`): SDP-wide exposure counts it, and nothing about it is
 * visible to the caller's tenant.
 */
async function recordOtherOrgDeposit(
  vault: string,
  amount: string,
  provider = "kamino"
): Promise<void> {
  const positionId = generateEarnPositionId();
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', ?, 'vault_direct', ?, ?, ?, ?, 'Other Org', sdp_iso_now())`
      )
      .bind(
        positionId,
        OTHER_ORG.id,
        OTHER_PROJECT.id,
        provider,
        OTHER_OWNER,
        vault,
        SHARE_MINT,
        USDC_MINT
      ),
    getDb(env)
      .prepare(
        `INSERT INTO earn_movements (
           id, organization_id, project_id, environment, provider,
           execution_model, direction, position_id, status,
           denomination, amount_requested, owner_address, vault_address,
           source_address, destination_address, signature, signed_transaction,
           last_valid_block_height, request_id, idempotency_fingerprint
         ) VALUES (?, ?, ?, 'sandbox', ?, 'vault_direct', 'deposit', ?, 'submitted',
                   ?, ?, ?, ?, ?, ?, 'sig_other_org_deposit', 'AQ==', '12345', ?, 'fp_other_org')`
      )
      .bind(
        generateEarnMovementId(),
        OTHER_ORG.id,
        OTHER_PROJECT.id,
        provider,
        positionId,
        USDC_MINT,
        amount,
        OTHER_OWNER,
        vault,
        OTHER_OWNER,
        vault,
        crypto.randomUUID()
      ),
  ]);
}

function post(strategyId: string, external: boolean, key: string = crypto.randomUUID()) {
  return app.request(
    "/v1/earn/deposit",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        strategyId,
        source: external ? { ownerAddress: WALLET_ADDRESS } : { walletId: CUSTODY_WALLET_ID },
        amount: { mint: USDC_MINT, value: "10" },
      }),
    },
    env
  );
}

function evaluatedEvents() {
  return logEvent.mock.calls
    .filter(([, payload]) => payload?.event === "sdp_api_earn_volume_cap_evaluated")
    .map(([level, payload]) => ({ level, payload: payload as Record<string, unknown> }));
}

async function expectRedactedCapRefusal(res: Response, vaultAddress: string) {
  expect(res.status, await res.clone().text()).toBe(409);
  const text = await res.text();
  expect(JSON.parse(text)).toMatchObject({
    error: { code: "VAULT_EXPOSURE_CAP", details: { vaultAddress } },
  });
  expect(text).not.toContain(DEFAULT_CEILING);
  expect(text).not.toContain("5000010");
}

beforeEach(async () => {
  originalCapsEnforced = env.EARN_VOLUME_CAPS_ENFORCED;
  env.EARN_VOLUME_CAPS_ENFORCED = "true";
  exposureReadFailure.current = null;
  resetVaultExposureCacheForTesting();
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.resetAllMocks();
  build.mockImplementation(async (binding: Env, input: ExternalWalletDepositBuildInput) => ({
    kind: "built",
    built: await createPostgresEarnExternalWalletTransactionsRepository(getDb(binding)).create({
      id: generateEarnExternalWalletTransactionId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: "sandbox",
      provider: input.provider,
      strategyId: input.strategyId,
      custodyWalletId: input.custodyWalletId,
      direction: "deposit",
      ownerAddress: input.ownerAddress,
      vaultAddress: input.providerReference,
      tokenMint: input.tokenMint,
      shareMint: input.shareMint,
      label: input.label,
      denomination: input.tokenMint,
      amountRequested: input.amount,
      minSharesOut: "1",
      createsShareAccount: false,
      unsignedTransaction: "AQ==",
      lastValidBlockHeight: "100",
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    }),
  }));
});
afterEach(() => {
  env.EARN_VOLUME_CAPS_ENFORCED = originalCapsEnforced;
  vi.restoreAllMocks();
});

describe("core deposit platform-wide exposure admission", () => {
  it.each([false, true])(
    "refuses a capped strategy before building (external=%s)",
    async (external) => {
      await seedAuth();
      const strategy = await seedStrategy();
      await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);
      await expectRedactedCapRefusal(
        await post(strategy.id, external),
        strategy.provider_reference
      );
      expect(build).not.toHaveBeenCalled();
      expect(evaluatedEvents()).toEqual([
        {
          level: "warn",
          payload: expect.objectContaining({
            stage: "admission",
            environment: "sandbox",
            provider: "kamino",
            vault_address: strategy.provider_reference,
            exposure: DEFAULT_CEILING,
            amount: "10",
            projected: "5000010",
            limit: DEFAULT_CEILING,
            would_block: true,
            enforced: true,
          }),
        },
      ]);
    }
  );

  it.each([false, true])(
    "admits exactly the remaining headroom and returns only prepared terms (external=%s)",
    async (external) => {
      await seedAuth();
      const strategy = await seedStrategy();
      await recordOtherOrgDeposit(strategy.provider_reference, "4999990");
      const res = await post(strategy.id, external);
      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({
        data: { operation: { status: "prepared", resourceRef: null, result: null } },
      });
      expect(build).toHaveBeenCalledTimes(1);
      expect(evaluatedEvents()[0]?.payload).toMatchObject({
        exposure: "4999990",
        projected: DEFAULT_CEILING,
        would_block: false,
      });
    }
  );

  it("replays the same prepared operation without double-counting exposure or re-reading an unavailable ledger", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, "4999990");
    const prepared = await post(strategy.id, false, "prepared-at-cap");
    expect(prepared.status, await prepared.clone().text()).toBe(202);
    const original = await prepared.json();
    exposureReadFailure.current = new Error("ledger unavailable");
    const replay = await post(strategy.id, false, "prepared-at-cap");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ data: original.data });
    expect(build).toHaveBeenCalledTimes(1);
    expect(evaluatedEvents()).toHaveLength(1);
    expect((await post(strategy.id, false, "new-preparation")).status).toBe(503);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps shadow mode observable while preparing the deposit (external=%s)",
    async (external) => {
      env.EARN_VOLUME_CAPS_ENFORCED = undefined;
      await seedAuth();
      const strategy = await seedStrategy();
      await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);
      const res = await post(strategy.id, external);
      expect(res.status, await res.clone().text()).toBe(202);
      expect(build).toHaveBeenCalledTimes(1);
      expect(evaluatedEvents()[0]?.payload).toMatchObject({
        would_block: true,
        enforced: false,
        projected: "5000010",
      });
    }
  );

  it.each(["true", undefined])(
    "fails closed before any source builds when the aggregate is unreadable (enforced=%s)",
    async (enforced) => {
      env.EARN_VOLUME_CAPS_ENFORCED = enforced;
      await seedAuth();
      const strategy = await seedStrategy();
      exposureReadFailure.current = new Error("ledger unavailable");
      for (const external of [false, true]) {
        const res = await post(strategy.id, external);
        expect(res.status, await res.clone().text()).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
      }
      expect(build).not.toHaveBeenCalled();
      expect(evaluatedEvents()).toEqual(
        Array.from({ length: 2 }, () => ({
          level: "error",
          payload: expect.objectContaining({
            stage: "admission",
            error_message: "ledger unavailable",
          }),
        }))
      );
    }
  );
});
