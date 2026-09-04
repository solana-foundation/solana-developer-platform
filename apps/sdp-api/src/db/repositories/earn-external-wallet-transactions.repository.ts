import type { EarnMovementDirection, SdpEnvironment } from "@sdp/types";
import type { AppDb } from "@/db";

/**
 * Built external-wallet transactions (PRO-1722): the unsigned transactions SDP built
 * for an external (non-custodial) wallet to sign.
 *
 * NOT part of the movement ledger, and deliberately a separate repository: a
 * row here records that SDP built something signable, never that money moved.
 * The submit step is what turns one of these into an `earn_movements` row, and
 * that consumption (the `movement_id` stamp) is written by the LEDGER
 * repository inside the movement's own transaction, so the "one build lands at
 * most once" rule lives with the single ledger writer rather than here.
 *
 * An unconsumed row is inert: nothing broadcasts it, and the transaction it
 * holds expires with its recorded blockhash window.
 */

export const EARN_EXTERNAL_WALLET_TRANSACTION_ID_PREFIX = "earn_external_wallet_transaction_";

export function generateEarnExternalWalletTransactionId(): string {
  return `${EARN_EXTERNAL_WALLET_TRANSACTION_ID_PREFIX}${crypto.randomUUID()}`;
}

export interface EarnExternalWalletTransactionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  direction: EarnMovementDirection;
  owner_address: string;
  vault_address: string;
  token_mint: string;
  share_mint: string;
  label: string;
  /** Withdrawals name the existing holding; null for a deposit build. */
  position_id: string | null;
  /** Token mint for a deposit build, share mint for a withdrawal build. */
  denomination: string;
  amount_requested: string;
  /** Deposit min shares, or withdrawal min token amount; direction disambiguates the unit. */
  min_shares_out: string | null;
  creates_share_account: boolean;
  /**
   * Caller-provided partner fee payer compiled into the transaction, or null
   * when the owner pays. Committed at build time — the submit's message
   * equality makes a different fee payer a refused submit, never a swap.
   */
  fee_payer: string | null;
  /**
   * Who funds the share-ATA rent when this build creates the account: the fee
   * payer (embedded as the provider's rentPayer) or null for the owner.
   * Copied onto the movement at submit so the exit refunds the right party.
   */
  share_ata_rent_funder: string | null;
  /** Base64 wire bytes with empty signature slots, exactly as returned. */
  unsigned_transaction: string;
  /** NUMERIC in Postgres, read back as a string so uint64 round-trips exactly. */
  last_valid_block_height: string;
  movement_id: string | null;
  consumed_at: string | null;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateEarnExternalWalletTransactionInput {
  id: string;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  direction: EarnMovementDirection;
  ownerAddress: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  label: string;
  positionId?: string | null;
  denomination: string;
  amountRequested: string;
  /** Shared accepted output floor; withdrawal callers pass `minAmountOut` through this field. */
  minSharesOut?: string | null;
  createsShareAccount: boolean;
  feePayer?: string | null;
  shareAtaRentFunder?: string | null;
  unsignedTransaction: string;
  lastValidBlockHeight: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface EarnExternalWalletTransactionsRepository {
  create(
    input: CreateEarnExternalWalletTransactionInput
  ): Promise<EarnExternalWalletTransactionRow>;
  /** Org-scoped in the query (BOLA): a foreign id reads as absent, never as 403. */
  getById(params: {
    organizationId: string;
    transactionId: string;
  }): Promise<EarnExternalWalletTransactionRow | null>;
}

function mapRow(row: Record<string, unknown>): EarnExternalWalletTransactionRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    environment: row.environment as SdpEnvironment,
    provider: row.provider as string,
    direction: row.direction as EarnMovementDirection,
    owner_address: row.owner_address as string,
    vault_address: row.vault_address as string,
    token_mint: row.token_mint as string,
    share_mint: row.share_mint as string,
    label: row.label as string,
    position_id: row.position_id as string | null,
    denomination: row.denomination as string,
    amount_requested: row.amount_requested as string,
    min_shares_out: row.min_shares_out as string | null,
    creates_share_account: row.creates_share_account === true,
    fee_payer: (row.fee_payer as string | null) ?? null,
    share_ata_rent_funder: (row.share_ata_rent_funder as string | null) ?? null,
    unsigned_transaction: row.unsigned_transaction as string,
    last_valid_block_height: String(row.last_valid_block_height),
    movement_id: row.movement_id as string | null,
    consumed_at: row.consumed_at as string | null,
    created_by: row.created_by as string | null,
    initiated_by_key_id: row.initiated_by_key_id as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresEarnExternalWalletTransactionsRepository(
  db: AppDb
): EarnExternalWalletTransactionsRepository {
  return {
    async create(input) {
      const row = await db
        .prepare(
          `INSERT INTO earn_external_wallet_transactions (
             id, organization_id, project_id, environment, provider, direction,
             owner_address, vault_address, token_mint, share_mint, label,
             position_id, denomination, amount_requested, min_shares_out,
             creates_share_account, fee_payer, share_ata_rent_funder,
             unsigned_transaction, last_valid_block_height,
             created_by, initiated_by_key_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.environment,
          input.provider,
          input.direction,
          input.ownerAddress,
          input.vaultAddress,
          input.tokenMint,
          input.shareMint,
          input.label,
          input.positionId ?? null,
          input.denomination,
          input.amountRequested,
          input.minSharesOut ?? null,
          input.createsShareAccount,
          input.feePayer ?? null,
          input.shareAtaRentFunder ?? null,
          input.unsignedTransaction,
          input.lastValidBlockHeight,
          input.createdBy ?? null,
          input.initiatedByKeyId ?? null
        )
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("Failed to record the built earn external-wallet transaction");
      }
      return mapRow(row);
    },

    async getById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_external_wallet_transactions WHERE id = ? AND organization_id = ?`
        )
        .bind(params.transactionId, params.organizationId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },
  };
}
