import { SdpEarnError } from "@sdp/earn";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { buildEarnVaultWithdrawalFingerprint } from "@/lib/idempotency";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const withdrawFromVault = vi.hoisted(() => vi.fn());
const surfacingEnabled = vi.hoisted(() => ({ value: true }));

vi.mock("@/services/earn/vault-withdraw.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-withdraw.service")>()),
  withdrawFromVault,
}));

vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => surfacingEnabled.value,
}));

/**
 * Per-test override for the withdraw-capable client, delegating to the REAL
 * registry when unset — same pattern as `earn.vault.test.ts`. The preview
 * route reaches the client directly, and the real Veda client would quote
 * against a live RPC; Kamino cases stay on the real registry, whose client
 * genuinely lacks `quoteVaultWithdrawal`, so the 501 is measured, not staged.
 */
const vaultWithdrawClientOverride = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/services/earn/execution-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn/execution-registry")>();
  return {
    ...actual,
    resolveVaultWithdrawClient: (...args: Parameters<typeof actual.resolveVaultWithdrawClient>) =>
      (vaultWithdrawClientOverride.current as ReturnType<
        typeof actual.resolveVaultWithdrawClient
      > | null) ?? actual.resolveVaultWithdrawClient(...args),
  };
});

/**
 * `POST /v1/earn/vault-withdrawals` and its reads — the gates, the exit-safety
 * ASYMMETRY, and the signed-movement read contract.
 *
 * The deliberate contrast with `earn.vault.test.ts` (the deposit route) is the
 * point of half of these: the deposit takes surfacing + entitlement +
 * admission + an environment fail-close, and the EXIT takes none of them (ADR
 * 0002 "money out beats money off"). `seedAuth` here grants NO earn provider
 * override on purpose — every succeeding withdrawal in this file is also proof
 * that no entitlement gate crept in.
 */

const TEST_ORG = { id: "org_earn_vw", name: "Earn Vault Withdraw Org", slug: "earn-vw" };
const TEST_PROJECT = { id: "prj_test_earn_vw", slug: "test-earn-vw-project" };
const TEST_PRODUCTION_PROJECT = { id: "prj_test_earn_vw_prod", slug: "test-earn-vw-prod" };
const TEST_USER = { id: "usr_earn_vw", email: "earn-vw@example.com" };
const TEST_API_KEY = { id: "key_earn_vw", raw: "sk_test_earn_vw", prefix: "sk_test_ear" };
const PROD_API_KEY = { id: "key_earn_vw_prod", raw: "sk_live_earn_vw", prefix: "sk_live_ear" };
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
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_vw";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

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
         VALUES (?, ?, ?, ?, 'Earn VW Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
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

function movementRow(overrides: Partial<EarnMovementRow> = {}): EarnMovementRow {
  return {
    id: `earn_movement_${crypto.randomUUID()}`,
    organization_id: TEST_ORG.id,
    project_id: TEST_PROJECT.id,
    environment: "sandbox",
    provider: "kamino",
    execution_model: "vault_direct",
    direction: "withdrawal",
    position_id: "earn_position_mock",
    status: "submitted",
    failure_reason: null,
    confirmed_at: null,
    settled_at: null,
    denomination: SHARE_MINT,
    amount_requested: "10",
    amount_settled: null,
    fee_amount: null,
    min_shares_out: null,
    shares_out: null,
    payout_token: null,
    custody_wallet_id: CUSTODY_WALLET_ID,
    owner_address: null,
    vault_address: VAULT,
    source_address: VAULT,
    destination_address: WALLET_ADDRESS,
    provider_reference: null,
    signature: `sig_${crypto.randomUUID()}`,
    signed_transaction: "AQ==",
    last_valid_block_height: "12345",
    request_id: crypto.randomUUID(),
    idempotency_fingerprint: "{}",
    provider_data: {},
    created_by: null,
    initiated_by_key_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    creates_share_account: false,
    share_ata_rent_funder: null,
    ...overrides,
  };
}

function postVaultWithdrawal(
  body: Record<string, unknown>,
  options: { idempotencyKey?: string | null; apiKey?: string } = {}
) {
  const key = options.idempotencyKey === undefined ? crypto.randomUUID() : options.idempotencyKey;
  return app.request(
    "/v1/earn/vault-withdrawals",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey ?? TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(body),
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
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  surfacingEnabled.value = true;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  withdrawFromVault.mockImplementation(async (_env, input) => ({
    position: { id: input.positionId },
    movement: movementRow({ position_id: input.positionId, request_id: input.requestId }),
    replayed: false,
  }));
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  vaultWithdrawClientOverride.current = null;
  vi.restoreAllMocks();
});

describe("POST /v1/earn/vault-withdrawals — request validation", () => {
  it("requires an Idempotency-Key header, because the chain has no dedupe of its own", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    const res = await postVaultWithdrawal({ positionId, shares: "10" }, { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(withdrawFromVault).not.toHaveBeenCalled();
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
    expect(withdrawFromVault).not.toHaveBeenCalled();
  });

  it("rejects non-positive shares", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    for (const shares of ["0", "000.000", "-1", "1e6", ""]) {
      const res = await postVaultWithdrawal({ positionId, shares });
      expect(res.status, `shares=${JSON.stringify(shares)}`).toBe(400);
    }
    expect(withdrawFromVault).not.toHaveBeenCalled();
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
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES ('prj_earn_vw_other', 'org_earn_vw_other', 'Other', 'earn-vw-other-prj', 'sandbox', 'active', ?)`
        )
        .bind(TEST_USER.id),
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
    expect(withdrawFromVault).not.toHaveBeenCalled();
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
         VALUES ('epw_earn_vw', ?, ?, 'sandbox', 'ground', 'ref_earn_vw', ?)`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id)
      .run();
    const positionId = generateEarnPositionId();
    await getDb(env)
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           provider_wallet_id, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'ground', 'custodial', 'epw_earn_vw', 'Program', sdp_iso_now())`
      )
      .bind(positionId, TEST_ORG.id, TEST_PROJECT.id)
      .run();

    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/earn/vault-withdrawals — exit safety (ADR 0002)", () => {
  it("withdraws WITHOUT entitlement, surfacing, or a catalogue row", async () => {
    // Everything the deposit route requires is deliberately absent here: the
    // org has no earn provider override, `earn_strategies` holds no row for
    // this vault (it could be delisted), and surfacing answers NO for every
    // provider. Money out must not care.
    surfacingEnabled.value = false;
    await seedAuth();
    const positionId = await seedPosition();

    const res = await postVaultWithdrawal({ positionId, shares: "10" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { withdrawal: { positionId: string; signature: string; replayed: boolean } };
    };
    expect(body.data.withdrawal.positionId).toBe(positionId);
    expect(body.data.withdrawal.signature).toBeTruthy();
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
  });

  it("allows a sibling project's position when both projects share an org-level wallet", async () => {
    await seedAuth();
    await getDb(env).batch([
      getDb(env)
        .prepare("UPDATE custody_configs SET project_id = NULL WHERE id = 'cfg_earn_vw'")
        .bind(),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES ('prj_earn_vw_sibling', ?, 'Sibling', 'earn-vw-sibling', 'sandbox', 'active', ?)`
        )
        .bind(TEST_ORG.id, TEST_USER.id),
    ]);
    const positionId = await seedPosition({ projectId: "prj_earn_vw_sibling" });

    const res = await postVaultWithdrawal({ positionId, shares: "10" });

    expect(res.status).toBe(200);
    expect(withdrawFromVault).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ projectId: TEST_PROJECT.id, positionId }),
      expect.any(Object)
    );
  });

  it("withdraws in PRODUCTION even while vault deposits are environment-closed there", async () => {
    // The deposit route fail-closes production; an exit must work wherever a
    // position exists, or the fail-close itself would trap funds.
    const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, prodKeyHash, {
      ...TEST_CACHED_API_KEY,
      id: PROD_API_KEY.id,
      projectId: TEST_PRODUCTION_PROJECT.id,
      environment: "production",
    });
    await seedAuth();
    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Earn VW Prod Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        PROD_API_KEY.id,
        TEST_ORG.id,
        TEST_PRODUCTION_PROJECT.id,
        TEST_USER.id,
        PROD_API_KEY.prefix,
        prodKeyHash
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_earn_vw_prod', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(TEST_ORG.id, TEST_PRODUCTION_PROJECT.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_earn_vw_prod', 'cfg_earn_vw_prod', 'privy_earn_vw_prod', ?, 'active')`
      )
      .bind(WALLET_ADDRESS)
      .run();
    const positionId = await seedPosition({
      environment: "production",
      projectId: TEST_PRODUCTION_PROJECT.id,
      custodyWalletId: "cwlt_earn_vw_prod",
    });

    const res = await postVaultWithdrawal(
      { positionId, shares: "10" },
      { apiKey: PROD_API_KEY.raw }
    );

    expect(res.status).toBe(200);
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
    expect(withdrawFromVault.mock.calls[0][1]).toMatchObject({ environment: "production" });
  });

  it("answers 501 when the provider cannot build an exit — capability, never permission", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "ground" });
    withdrawFromVault.mockRejectedValue(
      new SdpEarnError("NOT_IMPLEMENTED", "ground vault withdrawals is not implemented yet")
    );

    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(501);
  });
});

describe("POST /v1/earn/vault-withdrawals — response shape", () => {
  it("serves one movement with its transaction signature", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    withdrawFromVault.mockResolvedValue({
      position: { id: positionId },
      movement: movementRow({
        position_id: positionId,
        status: "submitted",
        amount_requested: "10",
      }),
      replayed: false,
    });

    const res = await postVaultWithdrawal({ positionId, shares: "10" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        withdrawal: {
          movementId: string;
          shares: string;
          shareMint: string;
          signature: string;
        };
      };
    };
    expect(body.data.withdrawal.shares).toBe("10");
    expect(body.data.withdrawal.shareMint).toBe(SHARE_MINT);
    expect(body.data.withdrawal.signature).toBeTruthy();
  });

  it("returns 409 when replaying a failed withdrawal", async () => {
    await seedAuth();
    const positionId = await seedPosition();
    const requestId = "vw-failed-replay";
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    const recorded = await repository.createSignedVaultWithdrawalIntent({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "sandbox",
      provider: "kamino",
      positionId,
      vaultAddress: VAULT,
      custodyWalletId: CUSTODY_WALLET_ID,
      shareMint: SHARE_MINT,
      requestedShares: "10",
      walletAddress: WALLET_ADDRESS,
      signature: "sig_failed_replay",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId,
      idempotencyFingerprint: buildEarnVaultWithdrawalFingerprint({
        environment: "sandbox",
        provider: "kamino",
        positionId,
        shares: "10",
        minAmountOut: null,
      }),
    });
    await repository.advanceVaultMovement({
      movementId: recorded.movement.id,
      organizationId: TEST_ORG.id,
      toStatus: "failed",
      failureReason: "expired",
    });

    const res = await postVaultWithdrawal(
      { positionId, shares: "10" },
      { idempotencyKey: requestId }
    );

    expect(res.status).toBe(409);
    expect(withdrawFromVault).not.toHaveBeenCalled();
  });
});

describe("GET /v1/earn/vault-withdrawals — recorded movements", () => {
  async function recordWithdrawal(params: {
    requestId: string;
    projectId?: string;
    positionId?: string;
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
        provider: "kamino",
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
      data: { withdrawals: Array<{ movementId: string; shares: string; shareMint: string }> };
    };
    expect(page.data.withdrawals).toHaveLength(1);

    const detail = await getWithdrawal(`/${recorded.movement.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      data: { withdrawal: { movementId: string; signature: string } };
    };
    expect(body.data.withdrawal.movementId).toBe(recorded.movement.id);
    expect(body.data.withdrawal.signature).toBe(recorded.movement.signature);
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

  it("hides a sibling project's withdrawal from this project's key", async () => {
    await seedAuth();
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES ('prj_earn_vw_sibling', ?, 'Sibling', 'earn-vw-sibling', 'sandbox', 'active', ?)`
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();
    const { recorded } = await recordWithdrawal({
      requestId: "vw-sibling-key",
      projectId: "prj_earn_vw_sibling",
    });

    expect((await getWithdrawal(`/${recorded.movement.id}`)).status).toBe(404);
    expect((await getWithdrawal("?requestId=vw-sibling-key")).status).toBe(200);
    const page = (await (await getWithdrawal("?requestId=vw-sibling-key")).json()) as {
      data: { withdrawals: unknown[] };
    };
    expect(page.data.withdrawals).toHaveLength(0);
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
});

describe("POST /v1/earn/vault-withdrawals — the exit slippage floor", () => {
  it("passes the caller's minAmountOut through to the service verbatim", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const requestId = crypto.randomUUID();

    const res = await postVaultWithdrawal(
      { positionId, shares: "5", minAmountOut: "4.99" },
      { idempotencyKey: requestId }
    );

    expect(res.status).toBe(200);
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
    expect(withdrawFromVault.mock.calls[0]?.[1]).toMatchObject({
      positionId,
      shares: "5",
      minAmountOut: "4.99",
      requestId,
    });
  });
});

/**
 * `POST /v1/earn/vault-withdrawal-previews` — the exit quote. EXIT gates only:
 * position scoping (404) and capability (501), nothing money-in-shaped — plus
 * `wallets:read`, which is not a money-in gate: it backs the binding check the
 * read scopes through, and for a key with no wallet bindings that check is a
 * documented no-op.
 */
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
    });
    expect(client.quoteVaultWithdrawal).toHaveBeenCalledWith(expect.anything(), {
      providerReference: VAULT,
      shares: "5",
    });
  });

  it("answers 501 for a provider that cannot quote, measured against the real client", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "kamino" });

    const res = await postVaultWithdrawalPreview({ positionId, shares: "5" });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("answers 404 for a position this workspace cannot see", async () => {
    await seedAuth();

    const res = await postVaultWithdrawalPreview({
      positionId: "earn_position_missing",
      shares: "5",
    });

    expect(res.status).toBe(404);
  });

  it("refuses an earn:read-only key — wallets:read backs the binding check it reads through", async () => {
    await seedAuth();
    const positionId = await seedPosition({ provider: "veda" });
    const readOnlyKey = { id: "key_earn_vw_ro", raw: "sk_test_earn_vw_ro" };
    await seedCachedApiKey(env, await hashString(readOnlyKey.raw, env.API_KEY_PEPPER), {
      ...TEST_CACHED_API_KEY,
      id: readOnlyKey.id,
      permissions: ["earn:read"],
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

    // For a key with NO wallet bindings the handler's binding check is a
    // documented no-op, so this gate is the only thing keeping an
    // earn:read-only key from reading any org position's live payout while
    // GET /vault-positions answers the same key 403.
    expect(res.status).toBe(403);
  });
});
