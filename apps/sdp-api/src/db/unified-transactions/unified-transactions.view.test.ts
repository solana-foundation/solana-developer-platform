import {
  EARN_MOVEMENT_STATUSES,
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
  type UnifiedTransactionModuleStatus,
  wellKnownMint,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const PROJECT = "prj_unified_view";
const CUSTODY_WALLET = "cwlt_unified_view";
const RINGS_CONNECTION = "hrconn_unified_view";
const CREATED_AT = "2026-09-15T10:00:00.000Z";

async function seedBase(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();
  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(TEST_USER.id, TEST_USER.email)
    .run();
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await db
    .prepare(
      `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
       VALUES ('cfg_unified_view', ?, 'local', 'encrypted', 'active')`
    )
    .bind(TEST_ORG.id)
    .run();
  await db
    .prepare(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES (?, 'cfg_unified_view', 'wallet_unified_view', 'UnifiedViewWallet111', 'active')`
    )
    .bind(CUSTODY_WALLET)
    .run();
  await db
    .prepare(
      `INSERT INTO provider_credentials
         (id, organization_id, project_id, provider, label, scope, source, storage_backend,
          encrypted_secret_payload, status, created_by)
       VALUES ('pcred_hr_unified_view', ?, ?, 'helius_rings', 'Unified view', 'project',
               'stored', 'encrypted_db', 'test-only', 'active', ?)`
    )
    .bind(TEST_ORG.id, PROJECT, TEST_USER.id)
    .run();
  await db
    .prepare(
      `INSERT INTO helius_rings_connections
         (id, organization_id, project_id, name, provider_credential_id,
          provider_credential_scope_key, status, is_default, activated_at, created_by)
       VALUES (?, ?, ?, 'Unified view', 'pcred_hr_unified_view', ?, 'active', TRUE,
               sdp_iso_now(), ?)`
    )
    .bind(RINGS_CONNECTION, TEST_ORG.id, PROJECT, PROJECT, TEST_USER.id)
    .run();
}

async function assertProjectedStatus<M extends UnifiedTransactionModule>(
  module: M,
  id: string,
  status: UnifiedTransactionModuleStatus<M>
): Promise<void> {
  const expectedStatus = Object.entries(UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].status).find(
    ([candidate]) => candidate === status
  )?.[1];
  if (expectedStatus === undefined) {
    throw new Error(`missing status contract ${module}:${status}`);
  }
  const row = await getDb(env).queryOne<{ status: string | null }>(
    `SELECT status FROM unified_transactions
     WHERE organization_id = ? AND project_id = ? AND module = ? AND id = ?`,
    [TEST_ORG.id, PROJECT, module, id]
  );
  if (row === null) throw new Error(`missing unified row ${id}`);
  expect(row.status).not.toBeNull();
  expect(row.status).toBe(expectedStatus);
}

async function seedPayment(status: string): Promise<string> {
  const id = `xfr_status_${status}`;
  await getDb(env).execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
        destination_address, token, amount, type, direction, status, created_at, updated_at)
     VALUES (?, ?, ?, 'wallet_unified_view', ?, 'source', 'destination', ?, '1',
             'transfer', 'outbound', ?, ?, ?)`,
    [
      id,
      TEST_ORG.id,
      PROJECT,
      CUSTODY_WALLET,
      wellKnownMint("USDC", "devnet"),
      status,
      CREATED_AT,
      CREATED_AT,
    ]
  );
  return id;
}

async function seedPrivateChannel(status: string): Promise<string> {
  const id = `pcd_status_${status}`;
  await getDb(env).execute(
    `INSERT INTO private_channel_deposits
       (id, organization_id, project_id, instance_id, wallet_id, depositor, recipient,
        mint, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, 'instance', 'wallet_unified_view', 'depositor', 'recipient',
             'USDCMint', '1', ?, ?, ?)`,
    [id, TEST_ORG.id, PROJECT, status, CREATED_AT, CREATED_AT]
  );
  return id;
}

async function seedIssuance(status: string): Promise<string> {
  await getDb(env).execute(
    `INSERT INTO issued_tokens
       (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
     VALUES ('tok_unified_view', ?, ?, 'UnifiedViewMint111', 'Unified', 'UNI', 6, ?)
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT, TEST_ORG.id, TEST_USER.id]
  );
  const id = `itx_status_${status}`;
  await getDb(env).execute(
    `INSERT INTO issuance_transactions
       (id, token_id, organization_id, type, status, operation_params, created_at, updated_at)
     VALUES (?, 'tok_unified_view', ?, 'mint', ?, '{}', ?, ?)`,
    [id, TEST_ORG.id, status, CREATED_AT, CREATED_AT]
  );
  return id;
}

async function seedDvp(status: string): Promise<string> {
  const tradeId = `dvp_status_${status}`;
  await getDb(env).execute(
    `INSERT INTO dvp_trades
       (id, organization_id, project_id, swap_dvp, settlement_authority, user_a, user_b,
        mint_a, mint_b, nonce, token_program_a, token_program_b, amount_a, amount_b,
        expiry_timestamp, user_a_settlement_destination, user_b_settlement_destination,
        escrow_a, escrow_b, status, escrow_a_amount, escrow_b_amount,
        escrow_a_peak_amount, escrow_b_peak_amount, decimals_a, decimals_b)
     VALUES (?, ?, ?, ?, 'authority', 'user-a', 'user-b', 'mint-a', 'mint-b', '1',
             'program-a', 'program-b', '1', '2', '2000000000', 'destination-a',
             'destination-b', 'escrow-a', 'escrow-b', ?, '1', '2', '1', '2', 6, 6)`,
    [tradeId, TEST_ORG.id, PROJECT, `swap-${status}`, status]
  );
  await getDb(env).execute(
    `INSERT INTO dvp_leg_funding_claims
       (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height)
     VALUES (?, 'a', ?, ?, ?, ?, '100')`,
    [tradeId, TEST_ORG.id, PROJECT, CUSTODY_WALLET, `signature-${status}`]
  );
  return `${tradeId}:fund:a`;
}

async function seedRings(status: string): Promise<string> {
  const walletId = "rings_wallet_unified";
  await getDb(env).execute(
    `INSERT INTO helius_rings_wallets
       (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES (?, ?, ?, ?, 'Unified')
     ON CONFLICT (id) DO NOTHING`,
    [walletId, TEST_ORG.id, PROJECT, CUSTODY_WALLET]
  );
  const id = `rings_status_${status}`;
  const failed = status === "failed" || status === "voided";
  await getDb(env).execute(
    `INSERT INTO helius_rings_operations
       (id, organization_id, project_id, wallet_id, rings_connection_id, op_type, state,
        asset_mint, amount_raw, intent_key, failure_code, failure_message, retryable,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'transfer_anonymous', ?, ?, '1000000', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      TEST_ORG.id,
      PROJECT,
      walletId,
      RINGS_CONNECTION,
      status,
      wellKnownMint("USDC", "devnet"),
      `intent-${status}`,
      failed ? "proof_failed" : null,
      failed ? "failed fixture" : null,
      failed ? false : null,
      CREATED_AT,
      CREATED_AT,
    ]
  );
  return id;
}

async function seedEarn(status: string): Promise<string> {
  const earnStatuses: Readonly<Record<string, string>> =
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.status;
  const vaultStatuses: readonly string[] = EARN_MOVEMENT_STATUSES.vault_direct;
  const model = vaultStatuses.includes(status) ? "vault_direct" : "custodial";
  const positionId = `earn_position_${model}`;
  if (model === "vault_direct") {
    await getDb(env).execute(
      `INSERT INTO earn_positions
         (id, organization_id, project_id, environment, provider, kind, custody_wallet_id,
          vault_address, share_mint, token_mint, label, created_by, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, 'vault', 'share-mint',
               'token-mint', 'Vault', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [positionId, TEST_ORG.id, PROJECT, CUSTODY_WALLET, TEST_USER.id, CREATED_AT]
    );
  } else {
    await getDb(env).execute(
      `INSERT INTO earn_provider_wallets
         (id, organization_id, project_id, environment, provider, provider_wallet_ref, label, created_by)
       VALUES ('earn_provider_wallet_unified', ?, ?, 'sandbox', 'ground', 'provider-ref', 'Program', ?)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_ORG.id, PROJECT, TEST_USER.id]
    );
    await getDb(env).execute(
      `INSERT INTO earn_positions
         (id, organization_id, project_id, environment, provider, kind, provider_wallet_id,
          label, created_by, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'ground', 'custodial', 'earn_provider_wallet_unified',
               'Program', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [positionId, TEST_ORG.id, PROJECT, TEST_USER.id, CREATED_AT]
    );
  }
  const id = `earn_status_${status}`;
  const confirmed = status === "confirmed" || status === "finalized";
  const failed = status === "failed";
  await getDb(env).execute(
    `INSERT INTO earn_movements
       (id, organization_id, project_id, environment, provider, execution_model, direction,
        position_id, status, failure_reason, confirmed_at, settled_at, denomination,
        amount_requested, amount_settled, min_shares_out, shares_out, payout_token,
        custody_wallet_id, vault_address, signature, signed_transaction,
        last_valid_block_height, request_id, idempotency_fingerprint, created_by,
        created_at, updated_at)
     VALUES (?, ?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      TEST_ORG.id,
      PROJECT,
      model === "vault_direct" ? "kamino" : "ground",
      model,
      model === "vault_direct" ? "deposit" : "withdrawal",
      positionId,
      status,
      failed && model === "vault_direct" ? "failed fixture" : null,
      confirmed ? CREATED_AT : null,
      status === "finalized" ? CREATED_AT : null,
      model === "vault_direct" ? "token-mint" : "usd",
      earnStatuses[status] === "succeeded" ? "1" : null,
      model === "vault_direct" ? "1" : null,
      confirmed ? "1" : null,
      model === "custodial" ? "usdc" : null,
      model === "vault_direct" ? CUSTODY_WALLET : null,
      model === "vault_direct" ? "vault" : null,
      model === "vault_direct" ? `signature-${status}` : null,
      model === "vault_direct" ? `transaction-${status}` : null,
      model === "vault_direct" ? "100" : null,
      `request-${status}`,
      `fingerprint-${status}`,
      TEST_USER.id,
      CREATED_AT,
      CREATED_AT,
    ]
  );
  return id;
}

const seeders = {
  payments: seedPayment,
  earn: seedEarn,
  dvp: seedDvp,
  private_channels: seedPrivateChannel,
  issuance: seedIssuance,
  rings: seedRings,
} as const satisfies Record<UnifiedTransactionModule, (status: string) => Promise<string>>;

describe("unified_transactions view (postgres)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedBase();
  });

  afterEach(() => seedTestDatabase(env));

  it("maps every canonical module status to a non-null status class", async () => {
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      for (const status of UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].moduleStatuses) {
        const id = await seeders[module](status);
        await assertProjectedStatus(module, id, status);
      }
    }
  });

  async function seedVaultWithdrawal(id: string, tokenAmountSettled: string | null) {
    const positionId = "earn_position_vault_direct";
    await getDb(env).execute(
      `INSERT INTO earn_positions
         (id, organization_id, project_id, environment, provider, kind, custody_wallet_id,
          vault_address, share_mint, token_mint, label, created_by, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, 'vault', 'share-mint',
               'token-mint', 'Vault', ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [positionId, TEST_ORG.id, PROJECT, CUSTODY_WALLET, TEST_USER.id, CREATED_AT]
    );
    await getDb(env).execute(
      `INSERT INTO earn_movements
         (id, organization_id, project_id, environment, provider, execution_model, direction,
          position_id, status, confirmed_at, settled_at, denomination, amount_requested,
          amount_settled, token_amount_settled, custody_wallet_id, vault_address, signature,
          signed_transaction, last_valid_block_height, request_id, idempotency_fingerprint,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', 'withdrawal', ?, 'finalized', ?, ?,
               'share-mint', '4', '4', ?, ?, 'vault', ?, ?, '100', ?, ?, ?, ?, ?)`,
      [
        id,
        TEST_ORG.id,
        PROJECT,
        positionId,
        CREATED_AT,
        CREATED_AT,
        tokenAmountSettled,
        CUSTODY_WALLET,
        `signature-${id}`,
        `transaction-${id}`,
        `request-${id}`,
        `fingerprint-${id}`,
        TEST_USER.id,
        CREATED_AT,
        CREATED_AT,
      ]
    );
    return getDb(env).queryOne<{ amount: string | null; token: string | null; kind: string }>(
      `SELECT amount, token, kind FROM unified_transactions
       WHERE organization_id = ? AND project_id = ? AND module = 'earn' AND id = ?`,
      [TEST_ORG.id, PROJECT, id]
    );
  }

  it("reports a finalized vault withdrawal as its observed deposit-token payout", async () => {
    // Recorded in shares (4 of share-mint); the customer received 4.1 token-mint.
    await expect(seedVaultWithdrawal("earn_withdrawal_valued", "4.1")).resolves.toEqual({
      kind: "withdraw",
      amount: "4.1",
      token: "token-mint",
    });
  });

  it("keeps the share quantity and share mint while a withdrawal's payout is unvalued", async () => {
    await expect(seedVaultWithdrawal("earn_withdrawal_unvalued", null)).resolves.toEqual({
      kind: "withdraw",
      amount: "4",
      token: "share-mint",
    });
  });

  it("keeps persisted status vocabularies equal to the contracts", async () => {
    const constrained = [
      ["payments", "payment_transfers_status_check"],
      ["dvp", "dvp_trades_status_check"],
      ["private_channels", "private_channel_deposits_status_check"],
      ["issuance", "issuance_transactions_status_check"],
      ["rings", "helius_rings_operations_state_check"],
    ] as const satisfies readonly (readonly [UnifiedTransactionModule, string])[];
    for (const [module, constraint] of constrained) {
      const row = await getDb(env).queryOne<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ?`,
        [constraint]
      );
      if (row === null) throw new Error(`missing constraint ${constraint}`);
      const values = [...row.definition.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
      expect(values).toEqual(
        [...UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].moduleStatuses].sort()
      );
    }
    const earnRows = await getDb(env).queryMany<{ status: string }>(
      "SELECT DISTINCT status FROM earn_movement_statuses ORDER BY status"
    );
    expect(earnRows.map((row) => row.status)).toEqual(
      [...UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.moduleStatuses].sort()
    );
  });

  it("inherits tenant isolation from source tables", async () => {
    await seedPayment("processing");
    const visible = await runWithTenantDatabaseIdentity({ organizationId: TEST_ORG.id }, () =>
      getDb(env).queryMany<{ organization_id: string }>(
        "SELECT organization_id FROM unified_transactions WHERE module = 'payments'"
      )
    );
    const invisible = await runWithTenantDatabaseIdentity({ organizationId: "org_other" }, () =>
      getDb(env).queryMany<{ organization_id: string }>(
        "SELECT organization_id FROM unified_transactions WHERE module = 'payments'"
      )
    );
    expect(visible).toEqual([{ organization_id: TEST_ORG.id }]);
    expect(invisible).toEqual([]);
  });

  it("projects base-unit amounts in token units and attributes DvP custody per side", async () => {
    const tradeId = "dvp_amount_units";
    await getDb(env).execute(
      `INSERT INTO dvp_trades
         (id, organization_id, project_id, swap_dvp, settlement_authority, user_a, user_b,
          mint_a, mint_b, nonce, token_program_a, token_program_b, amount_a, amount_b,
          expiry_timestamp, user_a_settlement_destination, user_b_settlement_destination,
          escrow_a, escrow_b, status, escrow_a_amount, escrow_b_amount,
          escrow_a_peak_amount, escrow_b_peak_amount, decimals_a, decimals_b, close_signature,
          closed_at)
       VALUES (?, ?, ?, 'swap-amount-units', 'authority', 'user-a', 'user-b', 'mint-a',
               'mint-b', '1', 'program-a', 'program-b', '1', '2', '2000000000',
               'destination-a', 'destination-b', 'escrow-a', 'escrow-b', 'settled', '0', '0',
               '1000000', '2000000000', 6, 9, 'close-signature', ?)`,
      [tradeId, TEST_ORG.id, PROJECT, CREATED_AT]
    );
    await getDb(env).execute(
      `INSERT INTO dvp_leg_funding_claims
         (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height)
       VALUES (?, 'a', ?, ?, ?, 'fund-signature', '100')`,
      [tradeId, TEST_ORG.id, PROJECT, CUSTODY_WALLET]
    );
    const dvpRows = await getDb(env).queryMany<{
      amount: string | null;
      custody_wallet_id: string | null;
      id: string;
    }>(
      `SELECT id, custody_wallet_id, amount
       FROM unified_transactions
       WHERE module = 'dvp' AND kind = 'close' AND module_id = ? ORDER BY id`,
      [tradeId]
    );
    expect(dvpRows).toEqual([
      {
        id: `${tradeId}:close:a`,
        amount: expect.stringMatching(/^1(?:\.0+)?$/),
        custody_wallet_id: CUSTODY_WALLET,
      },
      {
        id: `${tradeId}:close:b`,
        amount: expect.stringMatching(/^2(?:\.0+)?$/),
        custody_wallet_id: null,
      },
    ]);

    const ringsId = await seedRings("draft");
    const ringsAmount = await getDb(env).queryOne<{ amount_matches: boolean }>(
      "SELECT amount::numeric = 1::numeric AS amount_matches FROM unified_transactions WHERE module = 'rings' AND id = ?",
      [ringsId]
    );
    if (ringsAmount === null) throw new Error("missing Rings amount fixture");
    expect(ringsAmount.amount_matches).toBe(true);
  });
});
