import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import {
  generateEarnMovementId,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * ADR 0004 layer 1 (PRO-1934): the SDP-wide vault exposure cap at deposit
 * admission, end to end through both money-in surfaces and the deposit
 * preview, plus the two postures that make it safe to ship: shadow mode never
 * refuses and never lies in a preview, and an unreadable exposure fails
 * CLOSED. The exit half of the contract (a vault at cap stays withdrawable) is
 * pinned beside the other exit-safety cases in `earn.vault-withdrawals.test.ts`.
 *
 * The vault is driven to its cap with the real PLATFORM DEFAULT (5M token
 * units, no TVL on a devnet row, so the absolute ceiling binds): one recorded
 * in-flight deposit of exactly 5M from ANOTHER organization, so the cases also
 * prove the aggregate is SDP-wide and not the caller's own.
 */

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const depositIntoVault = vi.hoisted(() => vi.fn());
vi.mock("@/services/earn/vault-deposit.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-deposit.service")>()),
  depositIntoVault,
}));

const buildExternalWalletDepositTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/services/earn/vault-external-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-external-wallet.service")>()),
  buildExternalWalletDepositTransaction,
}));

/** When set, the ledger aggregate throws instead of answering. */
const exposureReadFailure = vi.hoisted(() => ({ current: null as Error | null }));
vi.mock("@/db/repositories/earn-movements.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/db/repositories/earn-movements.repository")>();
  return {
    ...actual,
    createPostgresEarnMovementsRepository: (
      ...args: Parameters<typeof actual.createPostgresEarnMovementsRepository>
    ) => {
      const repo = actual.createPostgresEarnMovementsRepository(...args);
      return {
        ...repo,
        sumVaultDepositExposure: (params: Parameters<typeof repo.sumVaultDepositExposure>[0]) => {
          if (exposureReadFailure.current) return Promise.reject(exposureReadFailure.current);
          return repo.sumVaultDepositExposure(params);
        },
      };
    },
  };
});

const vaultDirectClientOverride = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/services/earn/execution-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn/execution-registry")>();
  return {
    ...actual,
    resolveVaultDirectClient: (...args: Parameters<typeof actual.resolveVaultDirectClient>) =>
      (vaultDirectClientOverride.current as ReturnType<
        typeof actual.resolveVaultDirectClient
      > | null) ?? actual.resolveVaultDirectClient(...args),
  };
});

const { resetVaultExposureCacheForTesting } = await import("@/services/earn/vault-exposure");

const TEST_ORG = { id: "org_earn_cap", name: "Earn Cap Org", slug: "earn-cap" };
const OTHER_ORG = { id: "org_earn_cap_other", name: "Earn Cap Other Org", slug: "earn-cap-other" };
const TEST_PROJECT = { id: "prj_test_earn_cap", slug: "test-earn-cap-project" };
const OTHER_PROJECT = { id: "prj_test_earn_cap_other", slug: "test-earn-cap-other" };
const TEST_USER = { id: "usr_earn_cap", email: "earn-cap@example.com" };
const TEST_API_KEY = { id: "key_earn_cap", raw: "sk_test_earn_cap", prefix: "sk_test_ear" };
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
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_OWNER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";
const CUSTODY_WALLET_ID = "cwlt_earn_cap";
/** The platform default's absolute ceiling, `DEFAULT_VAULT_EXPOSURE_CAP.maxAbsolute`. */
const DEFAULT_CEILING = "5000000";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
let originalCapsEnforced: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

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
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Earn Cap Test Key', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        keyHash,
        JSON.stringify(["*"])
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

function post(path: string, body: Record<string, unknown>, idempotencyKey?: string) {
  return app.request(
    `/v1/earn/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function quoteCapableClient() {
  return {
    buildVaultDeposit: vi.fn(),
    readVaultPositions: vi.fn(),
    sponsoredPrograms: vi.fn(() => []),
    quoteVaultDeposit: vi.fn().mockResolvedValue({
      sharesOut: "9.99",
      shareDecimals: 6,
      blockingIssues: [{ code: "PROVIDER_ISSUE", message: "From the provider" }],
    }),
  };
}

function evaluatedEvents() {
  return logEvent.mock.calls
    .filter(([, payload]) => payload?.event === "sdp_api_earn_volume_cap_evaluated")
    .map(([level, payload]) => ({ level, payload: payload as Record<string, unknown> }));
}

const CAP_ERROR = {
  code: "VAULT_EXPOSURE_CAP",
  details: {
    limit: DEFAULT_CEILING,
    exposure: DEFAULT_CEILING,
    projected: "5000010",
  },
};

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalCapsEnforced = env.EARN_VOLUME_CAPS_ENFORCED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  env.EARN_VOLUME_CAPS_ENFORCED = "true";
  exposureReadFailure.current = null;
  vaultDirectClientOverride.current = null;
  resetVaultExposureCacheForTesting();
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  depositIntoVault.mockResolvedValue({
    position: { id: "earn_position_cap_test" },
    movement: {
      id: "earn_movement_cap_test",
      status: "submitted",
      signature: "sig_test",
      failure_reason: null,
    },
    replayed: false,
  });
  buildExternalWalletDepositTransaction.mockResolvedValue({
    kind: "built",
    built: {
      id: "earn_external_wallet_transaction_cap_test",
      organization_id: TEST_ORG.id,
      project_id: TEST_PROJECT.id,
      environment: "sandbox",
      provider: "kamino",
      direction: "deposit",
      strategy_id: null,
      position_id: null,
      owner_address: WALLET_ADDRESS,
      fee_payer: null,
      vault_address: "vault",
      token_mint: USDC_MINT,
      share_mint: SHARE_MINT,
      label: "Capped USDC Vault",
      denomination: USDC_MINT,
      amount_requested: "10",
      min_shares_out: null,
      swap: null,
      transaction: "AQ==",
      last_valid_block_height: "361",
      status: "built",
      movement_id: null,
      created_by: TEST_USER.id,
      initiated_by_key_id: TEST_API_KEY.id,
      created_at: new Date().toISOString(),
      consumed_at: null,
      share_ata_rent_funder: null,
      creates_share_account: false,
    },
  });
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.EARN_VOLUME_CAPS_ENFORCED = originalCapsEnforced;
  vi.restoreAllMocks();
});

describe("vault exposure cap (ADR 0004 layer 1): enforced", () => {
  it("refuses a custody deposit that would take the vault past its cap with a typed 409", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);

    const res = await post(
      "vault-deposits",
      { strategyId: strategy.id, custodyWalletId: CUSTODY_WALLET_ID, amount: "10" },
      "capped-deposit"
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        ...CAP_ERROR,
        details: { ...CAP_ERROR.details, vaultAddress: strategy.provider_reference },
      },
    });
    expect(depositIntoVault).not.toHaveBeenCalled();
    expect(evaluatedEvents()).toEqual([
      {
        level: "warn",
        payload: expect.objectContaining({
          cap: "vault_exposure",
          environment: "sandbox",
          provider: "kamino",
          vault_address: strategy.provider_reference,
          exposure: DEFAULT_CEILING,
          tvl: null,
          amount: "10",
          projected: "5000010",
          limit: DEFAULT_CEILING,
          would_block: true,
          enforced: true,
        }),
      },
    ]);
  });

  it("refuses the external-wallet deposit build the same way", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);

    const res = await post("external-wallet/deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: WALLET_ADDRESS,
      amount: "10",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: CAP_ERROR });
    expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();
  });

  it("admits a deposit that lands exactly on the cap, counting in-flight deposits", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, "4999990");

    const res = await post(
      "vault-deposits",
      { strategyId: strategy.id, custodyWalletId: CUSTODY_WALLET_ID, amount: "10" },
      "at-cap-deposit"
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledTimes(1);
    expect(evaluatedEvents()[0]?.payload).toMatchObject({
      exposure: "4999990",
      projected: DEFAULT_CEILING,
      would_block: false,
    });
  });

  it("reports the cap as a blocking issue on the deposit preview, after the provider's own", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING, "veda");
    vaultDirectClientOverride.current = quoteCapableClient();

    const res = await post("vault-deposit-previews", { strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { blockingIssues: unknown[] } };
    expect(body.data.blockingIssues).toEqual([
      { code: "PROVIDER_ISSUE", message: "From the provider" },
      { code: "VAULT_EXPOSURE_CAP", message: expect.stringContaining("5000010") },
    ]);
  });

  it("serves a burst of previews from one ledger read", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    vaultDirectClientOverride.current = quoteCapableClient();

    for (let i = 0; i < 3; i += 1) {
      const res = await post("vault-deposit-previews", { strategyId: strategy.id, amount: "10" });
      expect(res.status).toBe(200);
    }
    // Every evaluation ran; the aggregate itself was read once (the TTL is
    // pinned in the service's unit tests; here the point is that the cache is
    // wired into the request path).
    expect(evaluatedEvents()).toHaveLength(3);
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING, "veda");
    const cached = await post("vault-deposit-previews", { strategyId: strategy.id, amount: "10" });
    expect(
      ((await cached.json()) as { data: { blockingIssues: unknown[] } }).data.blockingIssues
    ).toEqual([{ code: "PROVIDER_ISSUE", message: "From the provider" }]);
  });
});

describe("vault exposure cap (ADR 0004 layer 1): shadow mode", () => {
  beforeEach(() => {
    env.EARN_VOLUME_CAPS_ENFORCED = undefined;
  });

  it("admits the custody deposit and records would_block on the evaluated event", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);

    const res = await post(
      "vault-deposits",
      { strategyId: strategy.id, custodyWalletId: CUSTODY_WALLET_ID, amount: "10" },
      "shadow-deposit"
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledTimes(1);
    expect(evaluatedEvents()).toEqual([
      {
        level: "warn",
        payload: expect.objectContaining({
          would_block: true,
          enforced: false,
          projected: "5000010",
          limit: DEFAULT_CEILING,
        }),
      },
    ]);
  });

  it("builds the external-wallet deposit", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING);

    const res = await post("external-wallet/deposit-transactions", {
      strategyId: strategy.id,
      ownerAddress: WALLET_ADDRESS,
      amount: "10",
    });

    expect(res.status).toBe(200);
    expect(buildExternalWalletDepositTransaction).toHaveBeenCalledTimes(1);
    expect(evaluatedEvents()[0]?.payload).toMatchObject({ would_block: true, enforced: false });
  });

  it("does NOT report the cap on the preview: the deposit would succeed", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    await recordOtherOrgDeposit(strategy.provider_reference, DEFAULT_CEILING, "veda");
    vaultDirectClientOverride.current = quoteCapableClient();

    const res = await post("vault-deposit-previews", { strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { blockingIssues: unknown[] } };
    expect(body.data.blockingIssues).toEqual([
      { code: "PROVIDER_ISSUE", message: "From the provider" },
    ]);
    expect(evaluatedEvents()[0]?.payload).toMatchObject({ would_block: true, enforced: false });
  });
});

describe("vault exposure cap (ADR 0004 layer 1): fail closed", () => {
  it.each(["true", undefined])(
    "refuses the deposit with a 503 when the exposure cannot be read (enforced=%s)",
    async (enforced) => {
      env.EARN_VOLUME_CAPS_ENFORCED = enforced;
      await seedAuth();
      const strategy = await seedStrategy();
      exposureReadFailure.current = new Error("ledger unavailable");

      const deposit = await post(
        "vault-deposits",
        { strategyId: strategy.id, custodyWalletId: CUSTODY_WALLET_ID, amount: "10" },
        "unreadable-deposit"
      );
      expect(deposit.status).toBe(503);
      expect(await deposit.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
      expect(depositIntoVault).not.toHaveBeenCalled();

      const build = await post("external-wallet/deposit-transactions", {
        strategyId: strategy.id,
        ownerAddress: WALLET_ADDRESS,
        amount: "10",
      });
      expect(build.status).toBe(503);
      expect(buildExternalWalletDepositTransaction).not.toHaveBeenCalled();

      expect(evaluatedEvents()).toEqual([
        {
          level: "error",
          payload: expect.objectContaining({ error_message: "ledger unavailable" }),
        },
        {
          level: "error",
          payload: expect.objectContaining({ error_message: "ledger unavailable" }),
        },
      ]);
    }
  );
});
