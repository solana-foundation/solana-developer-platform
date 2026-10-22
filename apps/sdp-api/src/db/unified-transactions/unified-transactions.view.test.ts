import { EARN_MOVEMENT_STATUSES } from "@sdp/types/earn";
import type { PaymentTransferType } from "@sdp/types/payments";
import type { LegVerifier, TokenMovementBasis } from "@sdp/types/token-movements";
import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
  type UnifiedTransactionModuleStatus,
} from "@sdp/types/unified-transactions";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import type { PaymentTransferDirection } from "@/db/repositories/payments.repository";
import type { TokenMovementLegOwner } from "@/db/repositories/token-movement-legs.repository";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { seedTestCustodyRows } from "@/test/helpers/custody";
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
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: "cfg_unified_view",
        organizationId: TEST_ORG.id,
        projectId: PROJECT,
        provider: "local",
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: CUSTODY_WALLET,
        owner: { kind: "config", custodyConfigId: "cfg_unified_view" },
        walletId: "wallet_unified_view",
        publicKey: "UnifiedViewWallet111",
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
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

const LEG_MINT = wellKnownMint("USDC", "devnet");
const BATCH = "ptb_unified_view";

async function seedLeggedTransfer(input: {
  id: string;
  type: PaymentTransferType;
  direction: PaymentTransferDirection;
  amount: string;
}): Promise<string> {
  await getDb(env).execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
        destination_address, token, amount, type, direction, status, created_at, updated_at)
     VALUES (?, ?, ?, 'wallet_unified_view', ?, 'source', 'destination', ?, ?, ?, ?,
             'confirmed', ?, ?)`,
    [
      input.id,
      TEST_ORG.id,
      PROJECT,
      CUSTODY_WALLET,
      LEG_MINT,
      input.amount,
      input.type,
      input.direction,
      CREATED_AT,
      CREATED_AT,
    ]
  );
  return input.id;
}

/**
 * A landed leg in base units. A token leg is the USDC mint read at a slot; a
 * native leg has fixed terms. A chain leg records what the chain showed,
 * equal to its quote, as the on-ramp verifier writes it.
 */
async function seedLeg(
  owner: TokenMovementLegOwner,
  leg: {
    asset: "native" | "token";
    decimals: number;
    basis: TokenMovementBasis;
    debit: bigint;
    fee: bigint;
    credit: bigint;
    verifiedBy: LegVerifier;
  }
): Promise<void> {
  const ownerId = owner.kind === "transfer" ? owner.transferId : owner.recipientId;
  const token = leg.asset === "token";
  const chain = leg.verifiedBy === "chain";
  await getDb(env).execute(
    `INSERT INTO token_movement_legs
       (id, organization_id, project_id, payment_transfer_id, payment_transfer_recipient_id,
        asset_kind, mint, token_program, decimals, basis, quoted_debit, quoted_fee,
        quoted_credit, as_of_slot, as_of_unix_timestamp, observed_debit, observed_fee,
        observed_credit, verified_by, verification_state, verification_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric, ?::numeric, ?,
             ?::numeric, ?::numeric, ?::numeric, ?, 'verified', ?)`,
    [
      `tml_${ownerId}`,
      TEST_ORG.id,
      PROJECT,
      owner.kind === "transfer" ? owner.transferId : null,
      owner.kind === "batch_recipient" ? owner.recipientId : null,
      leg.asset,
      token ? LEG_MINT : null,
      token ? "spl-token" : null,
      leg.decimals,
      leg.basis,
      leg.debit.toString(),
      leg.fee.toString(),
      leg.credit.toString(),
      token ? "4200" : null,
      token ? 1_800_000_000 : null,
      chain ? leg.debit.toString() : null,
      chain ? leg.fee.toString() : null,
      chain ? leg.credit.toString() : null,
      leg.verifiedBy,
      chain ? "chain_delta_matched" : "sdp_built_transfer_landed",
    ]
  );
}

/** A USDC fee-mint leg: 1.005 leaves the source, 0.005 is withheld, 1 arrives. */
const FEE_LEG = {
  asset: "token",
  decimals: 6,
  debit: 1_005_000n,
  fee: 5_000n,
  credit: 1_000_000n,
} as const;

async function seedBatch(): Promise<void> {
  await seedProjectCryptoWalletCounterparty(getDb(env), {
    organizationId: TEST_ORG.id,
    projectId: PROJECT,
    createdBy: TEST_USER.id,
    counterpartyId: "cpty_unified_view",
    counterpartyAccountId: "cpacct_unified_view",
    walletAddress: "destination",
  });
  await getDb(env).execute(
    `INSERT INTO payment_transfer_batches
       (id, organization_id, project_id, source_custody_wallet_id, source_wallet_id,
        source_address, token, status, total_amount, recipient_count, transaction_count)
     VALUES (?, ?, ?, ?, 'wallet_unified_view', 'source', ?, 'confirmed', '999', 4, 3)`,
    [BATCH, TEST_ORG.id, PROJECT, CUSTODY_WALLET, LEG_MINT]
  );
}

async function seedRecipient(id: string, chunkId: string, amount: string): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO payment_transfer_recipients
       (id, batch_id, organization_id, project_id, transfer_id, counterparty_id,
        counterparty_account_id, destination_address, amount, status)
     VALUES (?, ?, ?, ?, ?, 'cpty_unified_view', 'cpacct_unified_view', 'destination', ?,
             'confirmed')`,
    [id, BATCH, TEST_ORG.id, PROJECT, chunkId, amount]
  );
}

async function paymentAmount(id: string): Promise<string | null> {
  const row = await getDb(env).queryOne<{ amount: string | null }>(
    "SELECT amount FROM unified_transactions WHERE module = 'payments' AND id = ?",
    [id]
  );
  if (row === null) throw new Error(`missing unified row ${id}`);
  return row.amount;
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

  it("projects a stranded approval_required Rings row as failed, not pending", async () => {
    const id = await seedRings("approval_required");
    const row = await getDb(env).queryOne<{ status: string; module_status: string }>(
      `SELECT status, module_status FROM unified_transactions
       WHERE organization_id = ? AND project_id = ? AND module = 'rings' AND id = ?`,
      [TEST_ORG.id, PROJECT, id]
    );
    expect(row).toEqual({ status: "failed", module_status: "failed" });
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

  it.each(["confirmed", "finalized"])(
    "withholds a legacy %s Kamino deposit projection until its finalized receipt is recorded",
    async (status) => {
      const id = await seedEarn(status);
      const read = () =>
        getDb(env).queryOne<{ amount: string | null; token: string }>(
          "SELECT amount, token FROM unified_transactions WHERE module = 'earn' AND id = ?",
          [id]
        );
      expect(await read()).toEqual({ amount: null, token: "token-mint" });
      await getDb(env).execute(
        "UPDATE earn_movements SET status = 'finalized', settled_at = sdp_iso_now(), token_amount_settled = amount_requested WHERE id = ?",
        [id]
      );
      expect(await read()).toEqual({ amount: null, token: "token-mint" });
      await getDb(env).execute(
        "UPDATE earn_movements SET status = 'finalized', settled_at = sdp_iso_now(), amount_settled = '0.3', token_amount_settled = '0.3', shares_out = '0.29', deposit_receipt_observed_at = sdp_iso_now() WHERE id = ?",
        [id]
      );
      expect(await read()).toEqual({ amount: "0.3", token: "token-mint" });
    }
  );

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
  it("shows an outbound row's quoted debit from its leg, not its stored text", async () => {
    const id = await seedLeggedTransfer({
      id: "xfr_leg_debit",
      type: "transfer",
      direction: "outbound",
      amount: "999",
    });
    await seedLeg(
      { kind: "transfer", transferId: id },
      { ...FEE_LEG, basis: "credit", verifiedBy: "construction" }
    );
    // A fee mint: the source's wallet loses the debit, not the credit.
    expect(await paymentAmount(id)).toBe("1.005");
  });

  it("shows an inbound row's credit: a request deposit and a verified on-ramp delivery", async () => {
    const deposit = await seedLeggedTransfer({
      id: "xfr_leg_inbound",
      type: "transfer",
      direction: "inbound",
      amount: "999",
    });
    await seedLeg(
      { kind: "transfer", transferId: deposit },
      { ...FEE_LEG, basis: "credit", verifiedBy: "construction" }
    );
    // The provider quoted 25; the chain shows 25.5 delivered.
    const onramp = await seedLeggedTransfer({
      id: "xfr_leg_onramp",
      type: "onramp",
      direction: "inbound",
      amount: "25",
    });
    await seedLeg(
      { kind: "transfer", transferId: onramp },
      {
        asset: "token",
        decimals: 6,
        basis: "credit",
        debit: 25_500_000n,
        fee: 0n,
        credit: 25_500_000n,
        verifiedBy: "chain",
      }
    );
    expect(await paymentAmount(deposit)).toBe("1");
    expect(await paymentAmount(onramp)).toBe("25.5");
  });

  it("shows an off-ramp's credit, the provider's deposit amount, beside a larger debit", async () => {
    const id = await seedLeggedTransfer({
      id: "xfr_leg_offramp",
      type: "offramp",
      direction: "outbound",
      amount: "1.00",
    });
    await seedLeg(
      { kind: "transfer", transferId: id },
      { ...FEE_LEG, basis: "credit", verifiedBy: "construction" }
    );
    expect(await paymentAmount(id)).toBe("1");
  });

  it("keeps a legacy row's stored amount: it has no leg", async () => {
    const id = await seedLeggedTransfer({
      id: "xfr_leg_legacy",
      type: "transfer",
      direction: "outbound",
      amount: "1.50",
    });
    expect(await paymentAmount(id)).toBe("1.50");
  });

  it("keeps the stored amount when the row's only leg is archived", async () => {
    const id = await seedLeggedTransfer({
      id: "xfr_leg_archived",
      type: "transfer",
      direction: "outbound",
      amount: "1.50",
    });
    await seedLeg(
      { kind: "transfer", transferId: id },
      { ...FEE_LEG, basis: "credit", verifiedBy: "construction" }
    );
    await getDb(env).execute("UPDATE token_movement_legs SET status = 'archived' WHERE id = ?", [
      `tml_${id}`,
    ]);
    expect(await paymentAmount(id)).toBe("1.50");
  });

  it.each([
    ["a whole number without a point", "token", 6, 2_000_000n, "2"],
    ["a fraction with its leading zero", "native", 9, 1n, "0.000000001"],
    ["a mint with no decimals", "token", 0, 7n, "7"],
    [
      "the largest u64 at 18 decimals, every digit",
      "token",
      18,
      18_446_744_073_709_551_615n,
      "18.446744073709551615",
    ],
  ] as const)(
    "formats %s in canonical token units",
    async (_case, asset, decimals, debit, shown) => {
      const id = await seedLeggedTransfer({
        id: `xfr_leg_format_${decimals}_${debit}`,
        type: "transfer",
        direction: "outbound",
        amount: "999",
      });
      await seedLeg(
        { kind: "transfer", transferId: id },
        {
          asset,
          decimals,
          basis: "debit",
          debit,
          fee: 0n,
          credit: debit,
          verifiedBy: "construction",
        }
      );
      expect(await paymentAmount(id)).toBe(shown);
    }
  );

  it("sums a batch chunk's recipient debits, and keeps a legacy chunk's stored amount", async () => {
    await seedBatch();
    const chunk = await seedLeggedTransfer({
      id: "xfr_leg_chunk",
      type: "transfer_batch",
      direction: "outbound",
      amount: "999",
    });
    const other = await seedLeggedTransfer({
      id: "xfr_leg_chunk_other",
      type: "transfer_batch",
      direction: "outbound",
      amount: "999",
    });
    const legacy = await seedLeggedTransfer({
      id: "xfr_leg_chunk_legacy",
      type: "transfer_batch",
      direction: "outbound",
      amount: "3",
    });
    await seedRecipient("ptr_leg_a", chunk, "1.005");
    await seedRecipient("ptr_leg_b", chunk, "0.5025");
    await seedRecipient("ptr_leg_other", other, "0.5");
    await seedRecipient("ptr_leg_legacy", legacy, "3");
    await seedLeg(
      { kind: "batch_recipient", recipientId: "ptr_leg_a" },
      { ...FEE_LEG, basis: "debit", verifiedBy: "construction" }
    );
    await seedLeg(
      { kind: "batch_recipient", recipientId: "ptr_leg_b" },
      {
        asset: "token",
        decimals: 6,
        basis: "debit",
        debit: 502_500n,
        fee: 2_500n,
        credit: 500_000n,
        verifiedBy: "construction",
      }
    );
    await seedLeg(
      { kind: "batch_recipient", recipientId: "ptr_leg_other" },
      {
        asset: "token",
        decimals: 6,
        basis: "debit",
        debit: 500_000n,
        fee: 0n,
        credit: 500_000n,
        verifiedBy: "construction",
      }
    );
    // Each chunk shows the debits of the recipients it pays, never the batch total.
    expect(await paymentAmount(chunk)).toBe("1.5075");
    expect(await paymentAmount(other)).toBe("0.5");
    expect(await paymentAmount(legacy)).toBe("3");
  });
});
