import type { AppDb } from "@/db";
import type {
  DvpTradeInsert,
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
    createSignature: (row.create_signature as string | null) ?? null,
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
         status, observed_at, create_signature, created_at, updated_at`;

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
              escrow_a, escrow_b, sdp_side, sdp_wallet_id, create_signature
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?, ?
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
          row.createSignature
        )
        .first<Record<string, unknown>>();
      if (!inserted) {
        throw new Error("DvP trade insert returned no row");
      }
      return mapDvpTradeRow(inserted);
    },

    async getById(scope: DvpTradeScope, id: string) {
      const row = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ? AND id = ?`
        )
        .bind(scope.organizationId, scope.projectId, id)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async getBySwapDvp(scope: DvpTradeScope, swapDvp: string) {
      const row = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ? AND swap_dvp = ?`
        )
        .bind(scope.organizationId, scope.projectId, swapDvp)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async listByProject(scope: DvpTradeScope, limit: number) {
      const result = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE organization_id = ? AND project_id = ?
            ORDER BY created_at DESC
            LIMIT ?`
        )
        .bind(scope.organizationId, scope.projectId, limit)
        .all<Record<string, unknown>>();
      return result.results.map((row) => mapDvpTradeRow(row));
    },
  };
}
