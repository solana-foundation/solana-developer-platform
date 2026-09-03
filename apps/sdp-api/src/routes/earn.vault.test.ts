import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Surfacing is real by default here — Kamino AND Veda are offered, so both
 * providers' happy paths run against the shipped map with no help.
 *
 * `forceOn` remains for exactly one case: the unknown-provider dispatch test,
 * which must get PAST the surfacing gate to measure the gate behind it. The
 * surfacing gate itself keeps its own tests, pinned against the real map with
 * upshift — registered and `vault_direct` but not offered. Same pattern as
 * `earn-program.test.ts` (Ground plays that role for the program routes).
 */
const surfacing = vi.hoisted(() => ({ forceOn: false }));

vi.mock("@sdp/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/types")>();
  return {
    ...actual,
    isEarnProviderSurfaced: (provider: string) =>
      surfacing.forceOn || actual.isEarnProviderSurfaced(provider),
  };
});

import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { createPostgresPolicyRepository } from "@/db/repositories/policy.repository.postgres";
import app from "@/index";
import { buildEarnVaultDepositFingerprint } from "@/lib/idempotency";
import { createTenantScope } from "@/lib/tenant-scope";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const depositIntoVault = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/vault-deposit.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-deposit.service")>()),
  depositIntoVault,
}));

/**
 * Per-test override for the executing vault-direct client, delegating to the
 * REAL registry when unset. The preview route reaches the client directly (no
 * service seam to mock), and the real Veda client would quote against a live
 * RPC. Kamino cases stay on the real registry, which is itself the fixture:
 * its client genuinely lacks `quoteVaultDeposit`, so the 501 is measured, not
 * staged.
 */
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

/**
 * `POST /v1/earn/vault-deposits` — the gates and the idempotency contract.
 *
 * Two of these titles are load-bearing beyond this file:
 * `value-moving-conformance.node.test.ts` names them verbatim as the `earn`
 * family's replay evidence, so renaming one fails that test rather than
 * silently dropping the guarantee.
 *
 * Everything here stops at or before the chain: the deposit path is gated,
 * resolved and ledgered long before an RPC is reached, and the cases that
 * matter for authorization and replay are all decided in that stretch.
 */

const TEST_ORG = { id: "org_earn_vault", name: "Earn Vault Org", slug: "earn-vault" };
const TEST_PROJECT = { id: "prj_test_earn_vault", slug: "test-earn-vault-project" };
const TEST_PRODUCTION_PROJECT = {
  id: "prj_test_earn_vault_prod",
  slug: "test-earn-vault-project-prod",
};
const TEST_USER = { id: "usr_earn_vault", email: "earn-vault@example.com" };
const TEST_API_KEY = {
  id: "key_earn_vault",
  raw: "sk_test_earn_vault",
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
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

async function seedWallet(params: {
  configId: string;
  custodyWalletId: string;
  providerWalletId: string;
  publicKey?: string;
  projectId?: string | null;
}): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(
        params.configId,
        TEST_ORG.id,
        params.projectId === undefined ? TEST_PROJECT.id : params.projectId
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        params.custodyWalletId,
        params.configId,
        params.providerWalletId,
        params.publicKey ?? WALLET_ADDRESS
      ),
  ]);
}

async function seedConnectionWallet(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, status, created_by
         ) VALUES ('pcred_earn_vault', ?, ?, 'privy', 'Vault BYOK', 'project',
                   'runtime', 'runtime_env', 'active', ?)`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status,
           provider_account_fingerprint, created_by
         ) VALUES ('cconn_earn_vault', ?, ?, 'privy', 'project',
                   'pcred_earn_vault', ?, 'pending', 'sha256:test', ?)`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES ('cwlt_earn_vault_connection', 'cconn_earn_vault',
                   'privy_earn_vault_connection', ?, 'active')`
      )
      .bind(WALLET_ADDRESS),
    getDb(env).prepare(
      `UPDATE custody_connections
         SET default_custody_wallet_id = 'cwlt_earn_vault_connection',
             status = 'active', last_check_status = 'success',
             last_check_at = sdp_iso_now(), activated_at = sdp_iso_now()
         WHERE id = 'cconn_earn_vault'`
    ),
  ]);
}

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
        JSON.stringify({ providerOverrides: { earn: { kamino: true, veda: true } } })
      ),
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
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PRODUCTION_PROJECT.id,
        TEST_ORG.id,
        "Production Project",
        TEST_PRODUCTION_PROJECT.slug,
        "production",
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
        "Earn Vault Test Key",
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

function postVaultDeposit(body: Record<string, unknown>, idempotencyKey?: string) {
  const request = { ...body };
  const key =
    idempotencyKey ?? (typeof request.requestId === "string" ? request.requestId : undefined);
  delete request.requestId;
  return app.request(
    "/v1/earn/vault-deposits",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(request),
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  depositIntoVault.mockResolvedValue({
    position: { id: "earn_vault_position_test" },
    movement: {
      id: "earn_vault_movement_test",
      status: "submitted",
      signature: "sig_test",
      failure_reason: null,
    },
    replayed: false,
  });
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  surfacing.forceOn = false;
  vaultDirectClientOverride.current = null;
  vi.restoreAllMocks();
});

describe("POST /v1/earn/vault-deposits — catalogue admission", () => {
  /**
   * The operator stop switch. `paused` rows are deliberately retained by the
   * catalogue sync so a human can halt deposits during an exploit or a depeg;
   * this path used to resolve the row by id with no status predicate at all, so
   * the switch had no effect on it.
   */
  it("refuses a paused strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ status: "paused" });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("paused");
  });

  it("refuses a deprecated strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ status: "deprecated" });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(400);
  });

  it("refuses a strategy whose host cluster is not fundable here", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("mainnet-beta");
  });
});

describe("POST /v1/earn/vault-deposits — request validation", () => {
  it("allows a policy dry-run without a throwaway Idempotency-Key", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_dry_run",
      custodyWalletId: "cwlt_earn_vault_dry_run",
      providerWalletId: "privy_earn_vault_dry_run",
    });

    const res = await app.request(
      "/v1/earn/vault-deposits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Dry-Run": "true",
        },
        body: JSON.stringify({
          strategyId: strategy.id,
          custodyWalletId: "cwlt_earn_vault_dry_run",
          amount: "10",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).not.toHaveBeenCalled();
    const operationCount = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM wallet_operations")
      .first<{ count: number | string }>();
    expect(Number(operationCount?.count ?? 0)).toBe(0);
  });

  it("requires an Idempotency-Key header, because the chain has no dedupe of its own", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
    });

    expect(res.status).toBe(400);
  });

  it("rejects a strategy without a deposit mint before policy can approve it", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ depositMints: [] });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_unused",
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(500);
    expect(depositIntoVault).not.toHaveBeenCalled();
    const operationCount = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM wallet_operations")
      .first<{ count: number | string }>();
    expect(Number(operationCount?.count ?? 0)).toBe(0);
  });

  it("rejects the retired body requestId source even when the canonical header is present", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    const res = await app.request(
      "/v1/earn/vault-deposits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "vault-header-key",
        },
        body: JSON.stringify({
          strategyId: strategy.id,
          custodyWalletId: "cwlt_unused",
          amount: "10",
          requestId: crypto.randomUUID(),
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "0",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a zero minSharesOut without lossy numeric coercion", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_unused",
      amount: "10",
      minSharesOut: "000.0000",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("404s an unknown strategy rather than leaking whether the id exists elsewhere", async () => {
    await seedAuth();

    const res = await postVaultDeposit({
      strategyId: "earn_strategy_does_not_exist",
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(404);
  });

  it("requires a custody row id and rejects a raw wallet address", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_raw_address",
      custodyWalletId: "cwlt_earn_vault_raw_address",
      providerWalletId: "privy_earn_vault_raw_address",
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: WALLET_ADDRESS,
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(404);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("selects the exact custody row when scoped configurations share an address", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_first",
      custodyWalletId: "cwlt_earn_vault_first",
      providerWalletId: "privy_earn_vault_first",
    });
    await seedWallet({
      configId: "cfg_earn_vault_second",
      custodyWalletId: "cwlt_earn_vault_second",
      providerWalletId: "privy_earn_vault_second",
      projectId: null,
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_second",
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        wallet: expect.objectContaining({
          id: "cwlt_earn_vault_second",
          walletId: "privy_earn_vault_second",
        }),
      }),
      expect.any(Object)
    );
  });

  it("accepts a connection-backed custody wallet row", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedConnectionWallet();

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_connection",
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        wallet: expect.objectContaining({
          id: "cwlt_earn_vault_connection",
          custodyConnectionId: "cconn_earn_vault",
        }),
      }),
      expect.any(Object)
    );
  });

  it("replays a pending policy approval for the same Idempotency-Key", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_pending",
      custodyWalletId: "cwlt_earn_vault_pending",
      providerWalletId: "privy_earn_vault_pending",
    });
    const key = "vault-pending-approval-key";
    const fingerprint = buildEarnVaultDepositFingerprint({
      environment: "sandbox",
      provider: strategy.provider,
      providerReference: strategy.provider_reference,
      custodyWalletId: "cwlt_earn_vault_pending",
      amount: "10",
      minSharesOut: null,
    });
    const policyRepo = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    const operation = await policyRepo.createWalletOperation({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: "cwlt_earn_vault_pending",
      walletId: "privy_earn_vault_pending",
      apiKeyId: TEST_API_KEY.id,
      source: "earn_vault_deposit",
      operationFamily: "program",
      operationType: "earn_vault_deposit",
      asset: USDC_MINT,
      amount: "10",
      destination: strategy.provider_reference,
      rawPayload: { idempotencyFingerprint: fingerprint },
      idempotencyKey: key,
      status: "pending_approval",
    });
    expect(operation).not.toBeNull();

    const response = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_pending",
        amount: "10",
      },
      key
    );

    expect(response.status).toBe(202);
    expect(depositIntoVault).not.toHaveBeenCalled();
    const count = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count FROM wallet_operations
         WHERE organization_id = ? AND project_id = ? AND idempotency_key = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, key)
      .first<{ count: number | string }>();
    expect(Number(count?.count ?? 0)).toBe(1);
  });

  it("refuses a key first used by a sibling project instead of replaying its deposit", async () => {
    // Reachable only because an ORGANIZATION-level custody config is handed to
    // every project in the org, so both projects resolve the same
    // `custody_wallets` row and the rest of the request matches. The API's
    // replay lookup is keyed on (organization_id, request_id) and the server
    // fingerprint omits the project, so without an explicit project check this
    // returned the SIBLING project's movement — answering the wrong deposit and
    // exposing its amount and signature.
    await seedAuth();
    const strategy = await seedStrategy();
    const siblingProject = "prj_test_earn_vault_sibling";
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Sibling', 'test-earn-vault-sibling', 'sandbox', 'active', ?)`
      )
      .bind(siblingProject, TEST_ORG.id, TEST_USER.id)
      .run();
    // project_id NULL == organization-level, visible to every project.
    await seedWallet({
      configId: "cfg_earn_vault_org_level",
      custodyWalletId: "cwlt_earn_vault_org_level",
      providerWalletId: "privy_earn_vault_org_level",
      projectId: null,
    });

    const key = "key-first-used-by-the-sibling-project";
    await createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
      organizationId: TEST_ORG.id,
      projectId: siblingProject,
      environment: "sandbox",
      provider: strategy.provider,
      vaultAddress: strategy.provider_reference,
      custodyWalletId: "cwlt_earn_vault_org_level",
      sourceAddress: "OrgLevelWalletPublicKey1111111111111111111",
      tokenMint: USDC_MINT,
      shareMint: SHARE_MINT,
      label: strategy.name,
      requestedAmount: "10",
      signature: `sig_${crypto.randomUUID()}`,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId: key,
      idempotencyFingerprint: buildEarnVaultDepositFingerprint({
        environment: "sandbox",
        provider: strategy.provider,
        providerReference: strategy.provider_reference,
        custodyWalletId: "cwlt_earn_vault_org_level",
        amount: "10",
        minSharesOut: null,
      }),
      createdBy: TEST_USER.id,
    });

    const response = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_org_level",
        amount: "10",
      },
      key
    );

    // 409, not a 200 replay of the sibling's movement.
    expect(response.status).toBe(409);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("rejects a provider wallet id even when scoped configurations reuse it", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_duplicate_a",
      custodyWalletId: "cwlt_earn_vault_duplicate_a",
      providerWalletId: "privy_earn_vault_duplicate",
    });
    await seedWallet({
      configId: "cfg_earn_vault_duplicate_b",
      custodyWalletId: "cwlt_earn_vault_duplicate_b",
      providerWalletId: "privy_earn_vault_duplicate",
      publicKey: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF",
      projectId: null,
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "privy_earn_vault_duplicate",
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(404);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("does not let a selected-wallet key cross an ambiguous provider wallet id", async () => {
    await seedAuth();
    const strategy = await seedStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_bound_project",
      custodyWalletId: "cwlt_earn_vault_bound_project",
      providerWalletId: "privy_earn_vault_bound_duplicate",
    });
    await seedWallet({
      configId: "cfg_earn_vault_bound_org",
      custodyWalletId: "cwlt_earn_vault_bound_org",
      providerWalletId: "privy_earn_vault_bound_duplicate",
      projectId: null,
    });
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_CACHED_API_KEY,
      signingWalletId: "privy_earn_vault_bound_duplicate",
      walletBindings: [
        {
          walletId: "privy_earn_vault_bound_duplicate",
          permissions: ["earn:write"],
        },
      ],
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_bound_org",
      amount: "10",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(403);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });
});

/**
 * Veda's dispatch through the provider-neutral deposit route.
 *
 * The route names no provider — it resolves a catalogue row, applies the
 * money-in gates and hands the resolved identity to `depositIntoVault`, which
 * narrows on capability. So "does Veda work here?" is really "does a second
 * `vault_direct` provider need any route change?", and the answer these cases
 * pin is no.
 */
describe("POST /v1/earn/vault-deposits — Veda", () => {
  const VEDA_SHARE_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";

  async function seedVedaStrategy() {
    return seedStrategy({
      provider: "veda",
      name: "Veda USDC vault #7",
      underlyingSource: undefined,
      shareMint: VEDA_SHARE_MINT,
      currentApy: null,
      riskMetadata: { platformFeeBps: 25, performanceFeeBps: 1000 },
    });
  }

  /**
   * THE GATE, run against the unmocked map. Veda was this case's fixture until
   * it was surfaced (2026-08-31); upshift inherits the role as the remaining
   * un-surfaced `vault_direct` provider — registered, so it clears the id and
   * style checks and fails on surfacing alone, before the provider is ever
   * called. If upshift ever flips, move this to whichever provider is off
   * rather than deleting it (same rule as the catalogue-visibility test in
   * earn.test.ts).
   */
  it("is refused for a provider that is not currently offered (upshift)", async () => {
    await seedAuth();
    const strategy = await seedStrategy({
      provider: "upshift",
      name: "Upshift USDC vault",
      underlyingSource: undefined,
    });
    await seedWallet({
      configId: "cfg_earn_vault_unsurfaced_gate",
      custodyWalletId: "cwlt_earn_vault_unsurfaced_gate",
      providerWalletId: "privy_earn_vault_unsurfaced_gate",
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_unsurfaced_gate",
      amount: "10",
      minSharesOut: "9.5",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(403);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("dispatches a surfaced Veda row with the catalogue's own asset identity", async () => {
    await seedAuth();
    const strategy = await seedVedaStrategy();
    await seedWallet({
      configId: "cfg_earn_vault_veda",
      custodyWalletId: "cwlt_earn_vault_veda",
      providerWalletId: "privy_earn_vault_veda",
    });
    const requestId = crypto.randomUUID();

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_veda",
      amount: "10",
      minSharesOut: "9.5",
      requestId,
    });

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledTimes(1);
    expect(depositIntoVault.mock.calls[0]?.[1]).toMatchObject({
      provider: "veda",
      providerReference: strategy.provider_reference,
      // Straight from the catalogue row, and the same values the builder's
      // `assetIdentity` is later compared against.
      tokenMint: USDC_MINT,
      shareMint: VEDA_SHARE_MINT,
      amount: "10",
      minSharesOut: "9.5",
      requestId,
    });
  });

  /**
   * A row whose provider this deployment cannot execute must fail CLOSED at the
   * provider gate, never reach dispatch. Catalogue rows persist `provider` as
   * open TEXT, so a newer deploy's id can reach this route.
   */
  it("fails closed on a strategy naming a provider this deployment cannot execute", async () => {
    surfacing.forceOn = true;
    await seedAuth();
    const strategy = await seedVedaStrategy();
    await getDb(env)
      .prepare("UPDATE earn_strategies SET provider = 'vedanext' WHERE id = ?")
      .bind(strategy.id)
      .run();
    await seedWallet({
      configId: "cfg_earn_vault_unknown",
      custodyWalletId: "cwlt_earn_vault_unknown",
      providerWalletId: "privy_earn_vault_unknown",
    });

    const res = await postVaultDeposit({
      strategyId: strategy.id,
      custodyWalletId: "cwlt_earn_vault_unknown",
      amount: "10",
      minSharesOut: "9.5",
      requestId: crypto.randomUUID(),
    });

    expect(res.status).toBe(503);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });
});

/**
 * `POST /v1/earn/vault-deposit-previews` — the quote the dashboard derives its
 * `minSharesOut` floor from. A read carrying the deposit's own money-in gates
 * and the quote capability's fail-closed answers.
 */
describe("POST /v1/earn/vault-deposit-previews", () => {
  function postVaultDepositPreview(body: Record<string, unknown>) {
    return app.request(
      "/v1/earn/vault-deposit-previews",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  function quoteCapableClient(quote: unknown) {
    return {
      buildVaultDeposit: vi.fn(),
      readVaultPositions: vi.fn(),
      // Required for the vault-direct capability (PRO-1736); the quote guard
      // narrows through supportsVaultDirect first.
      sponsoredPrograms: vi.fn(() => []),
      quoteVaultDeposit: vi.fn().mockResolvedValue(quote),
    };
  }

  it("answers the provider's own quote for a surfaced, quotable strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    const client = quoteCapableClient({
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }],
    });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      strategyId: strategy.id,
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }],
      // Sponsorship is unset in this harness, so the intent reads wallet-pays.
      feeSponsored: false,
    });
    expect(client.quoteVaultDeposit).toHaveBeenCalledWith(expect.anything(), {
      providerReference: strategy.provider_reference,
      amount: "10",
    });
  });

  it("answers a sanitized retryable 503 when live provider state is unreadable", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    const client = quoteCapableClient(undefined);
    client.quoteVaultDeposit.mockRejectedValue(
      Object.assign(new Error("RPC returned 429 from a secret endpoint"), {
        code: "VAULT_UNREADABLE",
      })
    );
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      message: "Earn provider is temporarily unavailable. Try again.",
    });
  });

  it("refuses an un-surfaced provider before quoting anything", async () => {
    await seedAuth();
    // Upshift: registered and `vault_direct`, so it reaches the surfacing gate
    // and stops there (Veda held this role until it was surfaced).
    const strategy = await seedStrategy({ provider: "upshift" });
    const client = quoteCapableClient({ sharesOut: "1", shareDecimals: 6, blockingIssues: [] });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(403);
    expect(client.quoteVaultDeposit).not.toHaveBeenCalled();
  });

  it("answers 501 for a provider that cannot quote, measured against the real client", async () => {
    await seedAuth();
    const strategy = await seedStrategy();

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("answers 404 for a strategy this workspace cannot see", async () => {
    await seedAuth();

    const res = await postVaultDepositPreview({ strategyId: "earn_strategy_missing", amount: "1" });

    expect(res.status).toBe(404);
  });
});
