import type { AppDb } from "@/db";
import type {
  DvpTradeInsert,
  DvpTradeObservationUpdate,
  DvpTradeRepository,
  DvpTradeRow,
  DvpTradeScope,
  DvpTradeSide,
  DvpTradeStatus,
} from "./dvp-trade.repository";

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`DvP trade ${field} is missing`);
  }
  return value;
}

function mapDvpTradeRow(row: Record<string, unknown>): DvpTradeRow {
  return {
    id: assertString(row.id, "id"),
    organizationId: assertString(row.organization_id, "organization_id"),
    projectId: assertString(row.project_id, "project_id"),
    swapDvp: assertString(row.swap_dvp, "swap_dvp"),

    settlementAuthority: assertString(row.settlement_authority, "settlement_authority"),
    userA: assertString(row.user_a, "user_a"),
    userB: assertString(row.user_b, "user_b"),
    mintA: assertString(row.mint_a, "mint_a"),
    mintB: assertString(row.mint_b, "mint_b"),
    // Stays a string all the way out. See the note in dvp-trade.repository.ts.
    nonce: assertString(row.nonce, "nonce"),

    tokenProgramA: assertString(row.token_program_a, "token_program_a"),
    tokenProgramB: assertString(row.token_program_b, "token_program_b"),

    amountA: assertString(row.amount_a, "amount_a"),
    amountB: assertString(row.amount_b, "amount_b"),
    expiryTimestamp: assertString(row.expiry_timestamp, "expiry_timestamp"),
    earliestSettlementTimestamp: (row.earliest_settlement_timestamp as string | null) ?? null,
    userASettlementDestination: assertString(
      row.user_a_settlement_destination,
      "user_a_settlement_destination"
    ),
    userBSettlementDestination: assertString(
      row.user_b_settlement_destination,
      "user_b_settlement_destination"
    ),
    refString: (row.ref_string as string | null) ?? null,

    escrowA: assertString(row.escrow_a, "escrow_a"),
    escrowB: assertString(row.escrow_b, "escrow_b"),

    sdpSide: row.sdp_side as DvpTradeSide,
    sdpWalletId: assertString(row.sdp_wallet_id, "sdp_wallet_id"),

    status: row.status as DvpTradeStatus,
    observedAt: (row.observed_at as string | null) ?? null,
    sdpLegFundingSignature: (row.sdp_leg_funding_signature as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    idempotencyFingerprint: (row.idempotency_fingerprint as string | null) ?? null,
    createSignature: (row.create_signature as string | null) ?? null,
    createLastValidBlockHeight: (row.create_last_valid_block_height as string | null) ?? null,
    escrowAAmount: (row.escrow_a_amount as string | null) ?? null,
    escrowBAmount: (row.escrow_b_amount as string | null) ?? null,
    escrowAFrozen: (row.escrow_a_frozen as boolean | null) ?? null,
    escrowBFrozen: (row.escrow_b_frozen as boolean | null) ?? null,
    createdAt: assertString(row.created_at, "created_at"),
    updatedAt: assertString(row.updated_at, "updated_at"),
  };
}

const SELECT_COLUMNS = `id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
         user_a_settlement_destination, user_b_settlement_destination, ref_string,
         escrow_a, escrow_b, sdp_side, sdp_wallet_id,
         status, observed_at, sdp_leg_funding_signature,
         idempotency_key, idempotency_fingerprint,
         create_signature, create_last_valid_block_height,
         escrow_a_amount, escrow_b_amount, escrow_a_frozen, escrow_b_frozen,
         created_at, updated_at`;

/**
 * The wallet allowlist clause, as SQL plus its bindings.
 *
 * An empty list is "authorized for no wallet" and must match nothing — `1 = 0`
 * rather than a dropped clause. Absent or null is genuinely unrestricted. That
 * asymmetry is the whole point: treating empty as "no filter" would hand a key
 * with no usable bindings the entire project's trades.
 */
function walletScopeClause(sdpWalletIds: string[] | null | undefined): {
  sql: string;
  bindings: string[];
} {
  if (sdpWalletIds === undefined || sdpWalletIds === null) {
    return { sql: "", bindings: [] };
  }
  if (sdpWalletIds.length === 0) {
    return { sql: " AND 1 = 0", bindings: [] };
  }
  const placeholders = sdpWalletIds.map(() => "?").join(", ");
  return { sql: ` AND sdp_wallet_id IN (${placeholders})`, bindings: sdpWalletIds };
}

export function createPostgresDvpTradeRepository(db: AppDb): DvpTradeRepository {
  return {
    async create(row: DvpTradeInsert) {
      const inserted = await db
        .prepare(
          `INSERT INTO dvp_trades (
              id, organization_id, project_id, swap_dvp,
              settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
              token_program_a, token_program_b,
              amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
              user_a_settlement_destination, user_b_settlement_destination, ref_string,
              escrow_a, escrow_b, sdp_side, sdp_wallet_id,
              idempotency_key, idempotency_fingerprint,
              create_signature, create_last_valid_block_height
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?
            )
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(
          row.id,
          row.organizationId,
          row.projectId,
          row.swapDvp,
          row.settlementAuthority,
          row.userA,
          row.userB,
          row.mintA,
          row.mintB,
          row.nonce,
          row.tokenProgramA,
          row.tokenProgramB,
          row.amountA,
          row.amountB,
          row.expiryTimestamp,
          row.earliestSettlementTimestamp,
          row.userASettlementDestination,
          row.userBSettlementDestination,
          row.refString,
          row.escrowA,
          row.escrowB,
          row.sdpSide,
          row.sdpWalletId,
          row.idempotencyKey,
          row.idempotencyFingerprint,
          row.createSignature,
          row.createLastValidBlockHeight
        )
        .first<Record<string, unknown>>();
      if (!inserted) {
        throw new Error("DvP trade insert returned no row");
      }
      return mapDvpTradeRow(inserted);
    },

    async resolveCreate(id: string, status: "created" | "create_failed") {
      // Compare-and-swap on 'creating'. A reconciler that already read the chain
      // and advanced the row has better information than this caller, so it wins
      // and we match zero rows rather than overwriting an observation.
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET status = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'creating'
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(status, id)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async listOpenForReconciliation(limit: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("listOpenForReconciliation limit must be an integer from 1 to 256");
      }
      // Stalest first, never-observed before that, so a busy cluster cannot
      // starve the trades nothing is known about.
      const result = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE status IN ('creating', 'created', 'partially_funded', 'funded')
            ORDER BY observed_at ASC NULLS FIRST, created_at ASC, id ASC
            LIMIT ?`
        )
        .bind(limit)
        .all<Record<string, unknown>>();
      return result.results.map((row) => mapDvpTradeRow(row));
    },

    async recordObservation(input: DvpTradeObservationUpdate) {
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET status = ?,
                  escrow_a_amount = ?,
                  escrow_b_amount = ?,
                  escrow_a_frozen = ?,
                  escrow_b_frozen = ?,
                  observed_at = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND status = ?
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(
          input.status,
          input.escrowAAmount,
          input.escrowBAmount,
          input.escrowAFrozen,
          input.escrowBFrozen,
          input.observedAt,
          input.id,
          input.expectedStatus
        )
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async getById(scope: DvpTradeScope, id: string) {
      const wallets = walletScopeClause(scope.sdpWalletIds);
      const row = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ? AND id = ?${wallets.sql}`
        )
        .bind(scope.organizationId, scope.projectId, id, ...wallets.bindings)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async getBySwapDvp(scope: DvpTradeScope, swapDvp: string) {
      const wallets = walletScopeClause(scope.sdpWalletIds);
      const row = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ? AND swap_dvp = ?${wallets.sql}`
        )
        .bind(scope.organizationId, scope.projectId, swapDvp, ...wallets.bindings)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async claimLegFunding(id: string, signature: string) {
      // Compare-and-swap: only the request that finds the column NULL may send.
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET sdp_leg_funding_signature = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND sdp_leg_funding_signature IS NULL
            RETURNING id`
        )
        .bind(signature, id)
        .first<{ id: string }>();
      return row !== null;
    },

    async releaseLegFunding(id: string, signature: string) {
      // Only the holder may release, so a late failure cannot clear a claim a
      // different request has since taken.
      await db
        .prepare(
          `UPDATE dvp_trades
              SET sdp_leg_funding_signature = NULL, updated_at = sdp_iso_now()
            WHERE id = ? AND sdp_leg_funding_signature = ?`
        )
        .bind(id, signature)
        .run();
    },

    async getByIdempotencyKey(projectId: string, idempotencyKey: string) {
      const row = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE project_id = ? AND idempotency_key = ?`
        )
        .bind(projectId, idempotencyKey)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async releaseIdempotencyKey(id: string) {
      // Guarded on `create_failed`, the one status that proves the create never
      // landed and never will. The key is cleared rather than the row deleted:
      // the failed attempt stays auditable, it just stops answering for a
      // request that was never made.
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET idempotency_key = NULL, updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'create_failed' AND idempotency_key IS NOT NULL
            RETURNING id`
        )
        .bind(id)
        .first<Record<string, unknown>>();
      return row !== null && row !== undefined;
    },

    async listByProject(scope: DvpTradeScope, limit: number) {
      const wallets = walletScopeClause(scope.sdpWalletIds);
      const result = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ?${wallets.sql}
            ORDER BY created_at DESC
            LIMIT ?`
        )
        .bind(scope.organizationId, scope.projectId, ...wallets.bindings, limit)
        .all<Record<string, unknown>>();
      return result.results.map((row) => mapDvpTradeRow(row));
    },
  };
}
