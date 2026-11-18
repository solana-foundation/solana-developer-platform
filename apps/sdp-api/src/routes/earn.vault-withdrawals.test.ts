import { supportsVaultWithdrawQuote } from "@sdp/earn/capabilities";
import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import {
  type CreateSignedQueuedWithdrawalRequestInput,
  createPostgresEarnVaultWithdrawalRequestsRepository,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  createPostgresEarnWalletTransactionsRepository,
  generateEarnWalletTransactionId,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { app } from "@/index";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import type { WalletWithdrawalBuildInput } from "@/services/earn/vault-wallet.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { recordCallScopes } from "@/test/helpers/cluster-scope";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const buildWithdrawal = vi.hoisted(() => vi.fn());
const surfacingEnabled = vi.hoisted(() => ({ value: true }));
const reconcileEarnVaultMovementReadThrough = vi.hoisted(() =>
  vi.fn(async (_env: unknown, movement: EarnMovementRow) => movement)
);

vi.mock("@/services/earn/vault-wallet.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-wallet.service")>()),
  buildWalletWithdrawalTransaction: buildWithdrawal,
}));
vi.mock("@/services/earn/vault-movement-reconciliation.service", () => ({
  reconcileEarnVaultMovementReadThrough,
}));

vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => surfacingEnabled.value,
}));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

/**
 * Per-test override for the withdraw-capable client, delegating to the REAL
 * registry when unset — same pattern as `earn.vault.test.ts`. The preview
 * route reaches the client directly, and the real Veda client would quote
 * against a live RPC. The 501 case stays on the real registry, which has no
 * executing client for upshift, so the refusal is measured, not staged
 * (Kamino held that role until it learned to quote).
 */
const vaultWithdrawClientOverride = vi.hoisted(() => ({ current: null as unknown }));
const parRedemptionClientOverride = vi.hoisted(() => ({ current: null as unknown }));
const coreClientOverride = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/services/earn/execution-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn/execution-registry")>();
  return {
    ...actual,
    resolveEarnExecutionClient: (...args: Parameters<typeof actual.resolveEarnExecutionClient>) =>
      (coreClientOverride.current as ReturnType<typeof actual.resolveEarnExecutionClient> | null) ??
      actual.resolveEarnExecutionClient(...args),
    resolveVaultWithdrawClient: (...args: Parameters<typeof actual.resolveVaultWithdrawClient>) =>
      (vaultWithdrawClientOverride.current as ReturnType<
        typeof actual.resolveVaultWithdrawClient
      > | null) ?? actual.resolveVaultWithdrawClient(...args),
    resolveVaultParRedemptionClient: (
      ...args: Parameters<typeof actual.resolveVaultParRedemptionClient>
    ) =>
      (parRedemptionClientOverride.current as ReturnType<
        typeof actual.resolveVaultParRedemptionClient
      > | null) ?? actual.resolveVaultParRedemptionClient(...args),
  };
});

/** Core withdrawal preparation shares the legacy position identity. History,
 * provider quotes, and pending request cancellation stay available for recovery. */
const TEST_ORG = { id: "org_earn_vw", name: "Earn Vault Withdraw Org", slug: "earn-vw" };
const TEST_PROJECT = { id: "prj_test_earn_vw", slug: "test-earn-vw-project" };
const TEST_PRODUCTION_PROJECT = { id: "prj_test_earn_vw_prod", slug: "test-earn-vw-prod" };
const TEST_USER = { id: "usr_earn_vw", email: "earn-vw@example.com" };
const TEST_API_KEY = { id: "key_earn_vw", raw: "sk_test_earn_vw", prefix: "sk_test_ear" };
const PROD_API_KEY = { id: "key_earn_vw_prod", raw: "sk_live_earn_vw", prefix: "sk_live_ear" };
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
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_vw";

let originalEncryptionKey: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      // NO providerOverrides: the exit route must never need entitlement.
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active", "{}"),
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
  const productionKeyHash = await seedProjectApiKey(getDb(env), env, {
    key: PROD_API_KEY,
    organizationId: TEST_ORG.id,
    projectId: TEST_PRODUCTION_PROJECT.id,
    createdBy: TEST_USER.id,
    grants: ALL_API_KEY_GRANTS,
  });
  await seedApiKeyRow(env, productionKeyHash, {
    ...TEST_SEEDED_API_KEY,
    id: PROD_API_KEY.id,
    projectId: TEST_PRODUCTION_PROJECT.id,
    environment: "production",
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, 'Earn VW Test Key', ?, ?, ?, 'active')`
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
         VALUES ('cfg_earn_vw', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_earn_vw', 'privy_earn_vw', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, WALLET_ADDRESS),
  ]);
}

async function seedPosition(
  overrides: Partial<{
    id: string;
    organizationId: string;
    projectId: string | null;
    environment: string;
    provider: string;
    kind: string;
    custodyWalletId: string;
    vaultAddress: string;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? generateEarnPositionId();
  const kind = overrides.kind ?? "vault_direct";
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         provider_wallet_id, label, activated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'Exit Vault', sdp_iso_now())`
    )
    .bind(
      id,
      overrides.organizationId ?? TEST_ORG.id,
      overrides.projectId === undefined ? TEST_PROJECT.id : overrides.projectId,
      overrides.environment ?? "sandbox",
      overrides.provider ?? "kamino",
      kind,
      overrides.custodyWalletId ?? CUSTODY_WALLET_ID,
      overrides.vaultAddress ?? VAULT,
      SHARE_MINT,
      USDC_MINT
    )
    .run();
  return id;
}

function postVaultWithdrawal(
  body: Record<string, unknown>,
  options: { idempotencyKey?: string | null; apiKey?: string } = {}
) {
  const key = options.idempotencyKey === undefined ? crypto.randomUUID() : options.idempotencyKey;
  return app.request(
    "/v1/earn/withdraw",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey ?? TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify({
        positionId: body.positionId,
        amount: { kind: "shares", value: body.shares },
        ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      }),
    },
    env
  );
}

function getWithdrawal(pathSuffix: string, apiKey = TEST_API_KEY.raw) {
  return app.request(
    `/v1/earn/vault-withdrawals${pathSuffix}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    env
  );
}

beforeEach(async () => {
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  surfacingEnabled.value = true;
  custodyReleaseChannel.outOfChannelMode = null;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  coreClientOverride.current = {
    provider: "kamino",
    buildVaultDeposit: vi.fn(),
    buildVaultWithdrawal: vi.fn(),
    readVaultPositions: vi.fn(),
    sponsoredPrograms: () => [],
    quoteVaultWithdrawal: vi.fn().mockResolvedValue({
      assetsOut: "9.9",
      assetDecimals: 6,
      blockingIssues: [],
    }),
  };
  buildWithdrawal.mockImplementation(async (binding: Env, input: WalletWithdrawalBuildInput) =>
    createPostgresEarnWalletTransactionsRepository(getDb(binding)).create({
      id: generateEarnWalletTransactionId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.projectId === TEST_PRODUCTION_PROJECT.id ? "production" : "sandbox",
      direction: "withdrawal",
      provider: input.provider,
      positionId: input.positionId,
      custodyWalletId: input.custodyWalletId,
      ownerAddress: input.ownerAddress,
      vaultAddress: input.vaultAddress,
      tokenMint: input.tokenMint,
      shareMint: input.shareMint,
      label: input.label,
      denomination: input.shareMint,
      amountRequested: input.shares,
      createsShareAccount: false,
      unsignedTransaction: "AQ==",
      lastValidBlockHeight: "100",
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    })
  );
});

afterEach(() => {
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  vaultWithdrawClientOverride.current = null;
  coreClientOverride.current = null;
  vi.restoreAllMocks();
});

describe("operation wallet scope", () => {
  it.each(["execute", "refresh", "cancel"].map((action) => ({ action })))(
    "refuses $action with wallet_out_of_scope before changing an operation",
    async ({ action }) => {
      await seedAuth();
      const positionId = await seedPosition();
      const prepared = await postVaultWithdrawal({ positionId, shares: "10" });
      expect(prepared.status, await prepared.clone().text()).toBe(202);
      const payload: {
        data: { operation: { id: string; actionId: string; version: number } };
      } = await prepared.json();
      const operation = payload.data.operation;
      const before = await getDb(env).queryOne<Record<string, unknown>>(
        "SELECT * FROM operations WHERE id = ?",
        [operation.id]
      );
      await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
        ...TEST_SEEDED_API_KEY,
        walletScope: "selected",
        walletIds: [],
      });
      buildWithdrawal.mockClear();
      const idempotencyKey = `outside-wallet-${action}`;
      const response = await app.request(
        `/v1/operations/${operation.id}/${action}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(
            action === "execute" ? { actionId: operation.actionId, version: operation.version } : {}
          ),
        },
        env
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { details: { reason: "wallet_out_of_scope" } },
      });
      expect(buildWithdrawal).not.toHaveBeenCalled();
      expect(
        await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [operation.id])
      ).toEqual(before);
      expect(
        await getDb(env).queryOne(
          "SELECT count(*)::int AS count FROM operation_attempts WHERE operation_id = ?",
          [operation.id]
        )
      ).toEqual({ count: 0 });
      expect(
        await getDb(env).queryOne(
          "SELECT count(*)::int AS count FROM idempotency_keys WHERE idempotency_key = ?",
          [idempotencyKey]
        )
      ).toEqual({ count: 0 });
    }
  );
});

describe("vault exits outside the key's wallet scope", () => {
  async function exitRows(): Promise<Record<string, unknown[]>> {
    const db = getDb(env);
    const entries = await Promise.all(
      [
        "earn_movements",
        "earn_vault_withdrawal_requests",
        "earn_vault_withdrawal_request_actions",
      ].map(
        async (table) =>
          [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results] as const
      )
    );
    return Object.fromEntries(entries);
  }

  async function scopeKeyToNoWallets(): Promise<void> {
    await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: [],
    });
  }

  it("refuses a withdrawal request cancellation with wallet_out_of_scope, leaving the request unchanged", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const requests = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    const input = {
      requestId: "earn_vault_withdrawal_request_out_of_scope",
      actionId: "earn_vault_withdrawal_action_out_of_scope",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "sandbox",
      provider: "veda",
      positionId,
      custodyWalletId: CUSTODY_WALLET_ID,
      ownerAddress: WALLET_ADDRESS,
      vaultAddress: VAULT,
      tokenMint: USDC_MINT,
      shareMint: SHARE_MINT,
      requestAddress: "QueueRequestAddressOutOfScope1111111111111",
      mechanism: "solver_queue",
      shares: "10",
      quotedAssets: "9.9",
      shareDecimals: 6,
      assetDecimals: 6,
      discountBps: 25,
      maturityTimestamp: "1700000060",
      deadlineTimestamp: "1700000120",
      signature: "queued-request-signature-out-of-scope",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      clientRequestId: "queued-request-out-of-scope",
      idempotencyFingerprint: "queued-request-fingerprint-out-of-scope",
      pdaLeaseToken: "earn_vault_withdrawal_reservation_out_of_scope",
      createdBy: TEST_USER.id,
    } as const satisfies CreateSignedQueuedWithdrawalRequestInput;
    await requests.acquireRequestReservation({
      id: input.pdaLeaseToken,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      provider: input.provider,
      vaultAddress: input.vaultAddress,
      ownerAddress: input.ownerAddress,
      requestAddress: input.requestAddress,
      clientRequestId: input.clientRequestId,
      idempotencyFingerprint: input.idempotencyFingerprint,
      expiresAt: "2099-01-01T00:00:00.000Z",
      mechanism: input.mechanism,
    });
    await requests.createSignedRequest(input);
    await scopeKeyToNoWallets();
    const before = await exitRows();

    const response = await app.request(
      `/v1/earn/vault-withdrawal-requests/${input.requestId}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "cancel-out-of-scope",
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", details: { reason: "wallet_out_of_scope" } },
    });
    expect(await exitRows()).toEqual(before);
  });
});

describe("POST /v1/earn/withdraw request validation", () => {
  it("requires an Idempotency-Key header, because the chain has no dedupe of its own", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    const res = await postVaultWithdrawal({ positionId, shares: "10" }, { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });

  it("rejects the retired body requestId source even when the canonical header is present", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    const res = await postVaultWithdrawal({
      positionId,
      shares: "10",
      requestId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });

  it("rejects non-positive shares", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    for (const shares of ["0", "000.000", "-1", "1e6", ""]) {
      const res = await postVaultWithdrawal({ positionId, shares });
      expect(res.status, `shares=${JSON.stringify(shares)}`).toBe(400);
    }
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });

  it("404s an unknown position rather than leaking whether the id exists elsewhere", async () => {
    await seedAuth();
    const res = await postVaultWithdrawal({
      positionId: generateEarnPositionId(),
      shares: "10",
    });
    expect(res.status).toBe(404);
  });

  it("404s a sibling organization's position (BOLA)", async () => {
    await seedAuth();
    await getDb(env).batch([
      getDb(env)
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
        )
        .bind("org_earn_vw_other", "Other Org", "earn-vw-other"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: "org_earn_vw_other",
      createdBy: TEST_USER.id,
      members: [],
      ids: {
        sandbox: "prj_earn_vw_other",
        production: "prj_earn_vw_other_production",
      },
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES ('cfg_earn_vw_other', 'org_earn_vw_other', 'prj_earn_vw_other', 'privy', 'e', 'active')`
        )
        .bind(),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_earn_vw_other', 'cfg_earn_vw_other', 'privy_earn_vw_other', 'Fore1gnWa11etPubKey111111111111111111111111', 'active')`
        )
        .bind(),
    ]);
    const foreign = await seedPosition({
      organizationId: "org_earn_vw_other",
      projectId: "prj_earn_vw_other",
      custodyWalletId: "cwlt_earn_vw_other",
    });

    const res = await postVaultWithdrawal({ positionId: foreign, shares: "10" });
    expect(res.status).toBe(404);
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });

  it("404s a production position presented by a sandbox key", async () => {
    await seedAuth();
    const positionId = await seedPosition({
      environment: "production",
      projectId: TEST_PRODUCTION_PROJECT.id,
    });
    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(404);
  });

  it("404s a custodial holding — programs exit through their own withdrawal route", async () => {
    await seedAuth();
    // A custodial position needs a provider wallet; the simplest honest seed is
    // a vault position whose kind check the route must refuse — so build one
    // via the earn_provider_wallets path.
    await getDb(env)
      .prepare(
        `INSERT INTO earn_provider_wallets
           (id, organization_id, project_id, environment, provider, provider_wallet_ref, created_by)
         VALUES ('epw_earn_vw', ?, ?, 'sandbox', 'upshift', 'ref_earn_vw', ?)`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id)
      .run();
    const positionId = generateEarnPositionId();
    await getDb(env)
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           provider_wallet_id, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'upshift', 'custodial', 'epw_earn_vw', 'Program', sdp_iso_now())`
      )
      .bind(positionId, TEST_ORG.id, TEST_PROJECT.id)
      .run();

    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/earn/withdraw exit safety (ADR 0002)", () => {
  it("withdraws WITHOUT entitlement, surfacing, or a catalogue row", async () => {
    // Everything the deposit route requires is deliberately absent here: the
    // org has no earn provider override, `earn_strategies` holds no row for
    // this vault (it could be delisted), and surfacing answers NO for every
    // provider. Money out must not care.
    surfacingEnabled.value = false;
    await seedAuth();
    const positionId = await seedPosition();

    const res = await postVaultWithdrawal({ positionId, shares: "10" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      data: {
        operation: {
          kind: "earn.withdraw",
          status: "prepared",
          intent: { positionId },
          resourceRef: null,
          result: null,
        },
      },
    });
    expect(buildWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("withdraws from a PAUSED strategy — admission stops money in, never money out", async () => {
    // The gate asymmetry stated on the operator stop switch itself:
    // `assertStrategyDepositable` refuses a paused row on every money-in path,
    // and the exit deliberately never consults the catalogue, so pausing a
    // strategy mid-incident cannot trap an existing position (EARN-012).
    await seedAuth();
    await createPostgresEarnRepository(getDb(env)).upsertStrategy({
      provider: "kamino",
      providerReference: VAULT,
      name: "Paused Exit Vault",
      sourceKind: "defi",
      underlyingSource: "kamino",
      depositMints: [USDC_MINT],
      shareMint: SHARE_MINT,
      apyType: "variable",
      currentApy: "0.062",
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: {},
      status: "paused",
      hostCluster: "devnet",
      environment: "sandbox",
    });
    const positionId = await seedPosition();

    const res = await postVaultWithdrawal({ positionId, shares: "10" });

    expect(res.status).toBe(202);
    expect(buildWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("withdraws from a vault AT its exposure cap while caps are enforced (ADR 0004)", async () => {
    // The vault exposure cap (PRO-1934) is a money-IN gate only. This drives
    // the vault to the platform default's ceiling (5M, absolute-only on a
    // devnet row) with an in-flight deposit, turns enforcement on, and exits:
    // the same vault that would now 409 a deposit must still pay out, or the
    // cap would trap funds.
    const originalCapsEnforced = env.EARN_VOLUME_CAPS_ENFORCED;
    env.EARN_VOLUME_CAPS_ENFORCED = "true";
    try {
      await seedAuth();
      const positionId = await seedPosition();
      await getDb(env)
        .prepare(
          `INSERT INTO earn_movements (
             id, organization_id, project_id, environment, provider,
             execution_model, direction, position_id, status,
             denomination, amount_requested, custody_wallet_id, vault_address,
             source_address, destination_address, signature, signed_transaction,
             last_valid_block_height, request_id, idempotency_fingerprint
           ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'deposit', ?, 'submitted',
                     ?, '5000000', ?, ?, ?, ?, 'sig_at_cap_deposit', 'AQ==', '12345', ?, 'fp_at_cap')`
        )
        .bind(
          `earn_movement_${crypto.randomUUID()}`,
          TEST_ORG.id,
          TEST_PROJECT.id,
          positionId,
          USDC_MINT,
          CUSTODY_WALLET_ID,
          VAULT,
          WALLET_ADDRESS,
          VAULT,
          crypto.randomUUID()
        )
        .run();

      const res = await postVaultWithdrawal({ positionId, shares: "10" });

      expect(res.status).toBe(202);
      expect(buildWithdrawal).toHaveBeenCalledTimes(1);
    } finally {
      env.EARN_VOLUME_CAPS_ENFORCED = originalCapsEnforced;
    }
  });

  it("withdraws in PRODUCTION even while vault deposits are environment-closed there", async () => {
    // The deposit route fail-closes production; an exit must work wherever a
    // position exists, or the fail-close itself would trap funds.
    const scopes = recordCallScopes(buildWithdrawal);
    const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
    await seedApiKeyRow(env, prodKeyHash, {
      ...TEST_SEEDED_API_KEY,
      id: PROD_API_KEY.id,
      projectId: TEST_PRODUCTION_PROJECT.id,
      environment: "production",
    });
    await seedAuth();
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
    await seedTestPrivyConnection(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PRODUCTION_PROJECT.id,
      connectionId: "cconn_earn_vw_prod",
      credentialId: "pcred_earn_vw_prod",
      createdBy: TEST_USER.id,
      stored: await writeTestPrivyCredentialSecret(env, {
        organizationId: TEST_ORG.id,
        credentialId: "pcred_earn_vw_prod",
        appId: "earn-vw-prod-app",
        appSecret: "earn-vw-prod-secret",
      }),
      providerAccountFingerprint: "sha256:earn-vw-prod",
      wallets: [
        {
          id: "cwlt_earn_vw_prod",
          walletId: "privy_earn_vw_prod",
          publicKey: WALLET_ADDRESS,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
      lastCheckStatus: "success",
      defaultCustodyWalletId: "cwlt_earn_vw_prod",
    });
    const positionId = await seedPosition({
      environment: "production",
      projectId: TEST_PRODUCTION_PROJECT.id,
      custodyWalletId: "cwlt_earn_vw_prod",
    });

    const res = await postVaultWithdrawal(
      { positionId, shares: "10" },
      { apiKey: PROD_API_KEY.raw }
    );

    expect(res.status).toBe(202);
    expect(buildWithdrawal).toHaveBeenCalledTimes(1);
    expect(scopes).toEqual([expect.objectContaining({ environment: "production" })]);
  });

  it("refuses an unsupported withdrawal adapter before building", async () => {
    await seedAuth();
    coreClientOverride.current = null;
    const positionId = await seedPosition({ provider: "upshift" });
    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(400);
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });
});

describe("POST /v1/earn/withdraw operation identity", () => {
  it("checks current wallet scope before creating a prepared withdrawal", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: [],
    });
    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { details: { reason: "wallet_out_of_scope" } },
    });
    expect(buildWithdrawal).not.toHaveBeenCalled();
  });

  it("rechecks the wallet grant before replaying an existing prepared action", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    const body = { positionId, shares: "10" };
    expect((await postVaultWithdrawal(body, { idempotencyKey: "scoped-withdrawal" })).status).toBe(
      202
    );
    await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: [],
    });
    expect((await postVaultWithdrawal(body, { idempotencyKey: "scoped-withdrawal" })).status).toBe(
      403
    );
    expect(buildWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("derives the enforced minimum from the live quote and requested tolerance", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const res = await app.request(
      "/v1/earn/withdraw",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "quoted-exit",
        },
        body: JSON.stringify({
          positionId,
          amount: { kind: "shares", value: "5" },
          slippageBps: 100,
        }),
      },
      env
    );
    expect(res.status, await res.clone().text()).toBe(202);
    expect(buildWithdrawal).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ positionId, shares: "5", minAmountOut: "9.801" })
    );
    expect(await res.json()).toMatchObject({
      data: { operation: { terms: { minimum: { mint: USDC_MINT, value: "9.801" } } } },
    });
  });

  it.each(["vault-withdrawals", "vault-withdrawal-requests"])(
    "retires fresh %s while preserving recorded history",
    async (path) => {
      await seedAuth();
      const positionId = await seedPosition();
      const res = await app.request(
        `/v1/earn/${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `retired-${path}`,
          },
          body: JSON.stringify({ positionId, shares: "10", mechanism: "operatorRedemption" }),
        },
        env
      );
      expect(res.status).toBe(410);
      expect(buildWithdrawal).not.toHaveBeenCalled();
    }
  );
});

describe("GET /v1/earn/vault-withdrawals — recorded movements", () => {
  it("404s another project's withdrawal", async () => {
    await seedAuth();
    const { recorded } = await recordWithdrawal({ requestId: "vw-project-scope" });
    expect((await getWithdrawal(`/${recorded.movement.id}`, PROD_API_KEY.raw)).status).toBe(404);
  });

  async function recordWithdrawal(params: {
    requestId: string;
    projectId?: string;
    positionId?: string;
    provider?: string;
  }) {
    const positionId = params.positionId ?? (await seedPosition());
    return {
      positionId,
      recorded: await createPostgresEarnMovementsRepository(
        getDb(env)
      ).createSignedVaultWithdrawalIntent({
        organizationId: TEST_ORG.id,
        projectId: params.projectId ?? TEST_PROJECT.id,
        environment: "sandbox",
        provider: params.provider ?? "kamino",
        positionId,
        vaultAddress: VAULT,
        custodyWalletId: CUSTODY_WALLET_ID,
        shareMint: SHARE_MINT,
        requestedShares: "10",
        walletAddress: WALLET_ADDRESS,
        signature: `sig_${crypto.randomUUID()}`,
        signedTransaction: "AQ==",
        lastValidBlockHeight: "12345",
        requestId: params.requestId,
        idempotencyFingerprint: `fp_${params.requestId}`,
      }),
    };
  }

  it("lists one logical withdrawal and reads it back by movement id", async () => {
    await seedAuth();
    const { recorded } = await recordWithdrawal({ requestId: "vw-list-key" });

    const list = await getWithdrawal("");
    expect(list.status).toBe(200);
    const page = (await list.json()) as {
      data: {
        withdrawals: Array<{
          movementId: string;
          shares: string;
          shareMint: string;
          ownerAddress: string | null;
        }>;
      };
    };
    expect(page.data.withdrawals).toHaveLength(1);
    // Custody rows record no owner — the wire names the wallet the movement
    // pays, so equal-sized orders from different wallets stay distinguishable.
    expect(page.data.withdrawals[0]?.ownerAddress).toBe(WALLET_ADDRESS);

    const detail = await getWithdrawal(`/${recorded.movement.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      data: { withdrawal: { movementId: string; signature: string; ownerAddress: string | null } };
    };
    expect(body.data.withdrawal.movementId).toBe(recorded.movement.id);
    expect(body.data.withdrawal.signature).toBe(recorded.movement.signature);
    expect(body.data.withdrawal.ownerAddress).toBe(WALLET_ADDRESS);
    expect(reconcileEarnVaultMovementReadThrough).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ id: recorded.movement.id })
    );
  });

  it("serves one withdrawal for ?requestId=", async () => {
    await seedAuth();
    const { recorded } = await recordWithdrawal({ requestId: "vw-group-key" });

    const res = await getWithdrawal("?requestId=vw-group-key");
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      data: { withdrawals: Array<{ signature: string }> };
    };
    expect(page.data.withdrawals).toHaveLength(1);
    expect(page.data.withdrawals[0]?.signature).toBe(recorded.movement.signature);
  });

  it("refuses a deposit from the withdrawal path — direction is the boundary", async () => {
    await seedAuth();
    const { recorded } = await recordWithdrawal({ requestId: "vw-direction-key" });
    // Flip the row to a deposit shape; the withdrawal detail must 404 it.
    await getDb(env)
      .prepare(
        `UPDATE earn_movements
            SET direction = 'deposit', denomination = ?, amount_requested = '10',
                signature = 'sig_direction', signed_transaction = 'AQ==',
                last_valid_block_height = 12345
          WHERE id = ?`
      )
      .bind(USDC_MINT, recorded.movement.id)
      .run();

    expect((await getWithdrawal(`/${recorded.movement.id}`)).status).toBe(404);
    const list = (await (await getWithdrawal("")).json()) as {
      data: { withdrawals: unknown[] };
    };
    expect(list.data.withdrawals).toHaveLength(0);
  });

  it("filters to unsettled logical withdrawals for recovery", async () => {
    await seedAuth();
    const settled = await recordWithdrawal({ requestId: "vw-settled-key" });
    const pending = await recordWithdrawal({
      requestId: "vw-pending-key",
      positionId: settled.positionId,
    });
    const confirmed = await recordWithdrawal({
      requestId: "vw-confirmed-key",
      positionId: settled.positionId,
    });
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    await repository.advanceVaultMovement({
      movementId: settled.recorded.movement.id,
      organizationId: TEST_ORG.id,
      toStatus: "failed",
      failureReason: "Transaction blockhash expired before confirmation",
    });
    await repository.advanceVaultMovement({
      movementId: confirmed.recorded.movement.id,
      organizationId: TEST_ORG.id,
      toStatus: "submitted",
    });
    await repository.advanceVaultMovement({
      movementId: confirmed.recorded.movement.id,
      organizationId: TEST_ORG.id,
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });

    const res = await getWithdrawal("?settled=false");
    const page = (await res.json()) as {
      data: { withdrawals: Array<{ movementId: string; status: string }> };
    };
    expect(page.data.withdrawals.map((withdrawal) => withdrawal.movementId)).toEqual([
      confirmed.recorded.movement.id,
      pending.recorded.movement.id,
    ]);
  });

  it("keeps a finalized provider-order withdrawal out of the settled set", async () => {
    await seedAuth();
    // A finalized wisdomtree withdrawal — whether a legacy dual-written row or
    // one the sweep stamped at chain finality — must stay discoverable under
    // settled=false and absent under settled=true: the settlement surface
    // never closes a provider-order row on a chain fact, only on an
    // authenticated provider completion fact.
    const positionId = await seedPosition({ provider: "wisdomtree" });
    const { recorded } = await recordWithdrawal({
      requestId: "vw-wt-finalized",
      positionId,
      provider: "wisdomtree",
    });
    await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
      movementId: recorded.movement.id,
      organizationId: TEST_ORG.id,
      toStatus: "finalized",
      confirmedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    });

    const unsettled = (await (await getWithdrawal("?settled=false")).json()) as {
      data: {
        withdrawals: Array<{ movementId: string; status: string; settledAt: string | null }>;
      };
    };
    const listed = unsettled.data.withdrawals.find(
      (withdrawal) => withdrawal.movementId === recorded.movement.id
    );
    expect(listed).toBeDefined();

    const settledOnly = (await (await getWithdrawal("?settled=true")).json()) as {
      data: { withdrawals: Array<{ movementId: string }> };
    };
    expect(
      settledOnly.data.withdrawals.some(
        (withdrawal) => withdrawal.movementId === recorded.movement.id
      )
    ).toBe(false);

    // The wire never claims a terminal settled state for a provider order: the
    // ledger's durable chain-finality evidence (`finalized` + settled_at)
    // reads as `confirmed` with no settledAt — the strongest honest
    // non-terminal fact, so clients keep seeing "awaiting provider settlement"
    // while WisdomTree completes the redemption off chain.
    const detail = (await (await getWithdrawal(`/${recorded.movement.id}`)).json()) as {
      data: { withdrawal: { status: string; settledAt: string | null } };
    };
    expect(detail.data.withdrawal).toMatchObject({
      status: "confirmed",
      settledAt: null,
    });
  });
});

describe("POST /v1/earn/vault-withdrawal-previews", () => {
  function postVaultWithdrawalPreview(body: Record<string, unknown>) {
    return app.request(
      "/v1/earn/vault-withdrawal-previews",
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
      // Required for the vault-direct capability (PRO-1736); the quote guard
      // narrows through supportsVaultDirect first.
      sponsoredPrograms: vi.fn(() => []),
      readVaultPositions: vi.fn(),
      buildVaultWithdrawal: vi.fn(),
      quoteVaultWithdrawal: vi.fn().mockResolvedValue(quote),
    };
  }

  it("answers the provider's own quote for the caller's position", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const client = quoteCapableClient({
      assetsOut: "4.997",
      assetDecimals: 6,
      blockingIssues: [],
    });
    vaultWithdrawClientOverride.current = client;

    const res = await postVaultWithdrawalPreview({ positionId, shares: "5" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      positionId,
      assetsOut: "4.997",
      assetDecimals: 6,
      blockingIssues: [],
      // Sponsorship is unset in this harness, so the intent reads wallet-pays.
      feeSponsored: false,
    });
    expect(client.quoteVaultWithdrawal).toHaveBeenCalledWith(expect.anything(), {
      providerReference: VAULT,
      shares: "5",
    });
  });

  it("answers 501 for a provider that cannot quote, measured against the real registry", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "upshift" });

    const res = await postVaultWithdrawalPreview({ positionId, shares: "5" });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  /** The real Kamino client, as the registry builds it, now clears the exit-quote guard. */
  it("measures the real Kamino client as withdrawal-quote capable", () => {
    coreClientOverride.current = null;
    const client = resolveEarnExecutionClient(env, "kamino", createVaultDeadline());
    if (!client) throw new Error("the registry must build a Kamino client");
    expect(supportsVaultWithdrawQuote(client)).toBe(true);
  });

  it("answers 404 for a position this workspace cannot see", async () => {
    await seedAuth();

    const res = await postVaultWithdrawalPreview({
      positionId: "earn_position_missing",
      shares: "5",
    });

    expect(res.status).toBe(404);
  });

  it("refuses a key without earn.read before it reads a position's live payout", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const readOnlyKey = { id: "key_earn_vw_ro", raw: "sk_test_earn_vw_ro" };
    await seedApiKeyRow(env, await hashString(readOnlyKey.raw, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      id: readOnlyKey.id,
      grants: ["transfers.read", "wallets.read"],
    });

    const res = await app.request(
      "/v1/earn/vault-withdrawal-previews",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readOnlyKey.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ positionId, shares: "5" }),
      },
      env
    );

    // The route's action is the gate: the handler's binding check is a
    // documented no-op for a key with NO wallet bindings.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { details: { action: "earn.read" } } });
  });
});
