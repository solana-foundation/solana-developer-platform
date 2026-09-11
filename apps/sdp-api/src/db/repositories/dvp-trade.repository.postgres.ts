import { DVP_TRADE_STATUSES } from "@sdp/types";
import { type Address, address, type Signature, signature } from "@solana/kit";
import { z } from "zod";
import type { AppDb } from "@/db";
import type { DatabaseExecutor } from "@/db/client";
import type {
  DvpTradeInsert,
  DvpTradeListFilters,
  DvpTradeObservationUpdate,
  DvpTradeRepository,
  DvpTradeRow,
  DvpTradeScope,
} from "./dvp-trade.repository";

const dvpTradeRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  swap_dvp: z.string(),
  settlement_authority: z.string(),
  user_a: z.string(),
  user_b: z.string(),
  mint_a: z.string(),
  mint_b: z.string(),
  nonce: z.string(),
  token_program_a: z.string(),
  token_program_b: z.string(),
  decimals_a: z.number().int().nullable(),
  decimals_b: z.number().int().nullable(),
  symbol_a: z.string().nullable(),
  symbol_b: z.string().nullable(),
  name_a: z.string().nullable(),
  name_b: z.string().nullable(),
  amount_a: z.string(),
  amount_b: z.string(),
  expiry_timestamp: z.string(),
  earliest_settlement_timestamp: z.string().nullable(),
  user_a_settlement_destination: z.string(),
  user_b_settlement_destination: z.string(),
  ref_string: z.string().nullable(),
  escrow_a: z.string(),
  escrow_b: z.string(),
  counterparty_account_id_a: z.string().nullable(),
  counterparty_account_id_b: z.string().nullable(),
  status: z.enum(DVP_TRADE_STATUSES),
  observed_at: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  idempotency_fingerprint: z.string().nullable(),
  create_signature: z.string().nullable(),
  create_last_valid_block_height: z.string().nullable(),
  close_signature: z.string().nullable(),
  close_resolution_attempts: z.number().int(),
  close_resolution_after: z.string().nullable(),
  escrow_a_amount: z.string().nullable(),
  escrow_b_amount: z.string().nullable(),
  escrow_a_peak_amount: z.string().nullable(),
  escrow_b_peak_amount: z.string().nullable(),
  escrow_a_frozen: z.boolean().nullable(),
  escrow_b_frozen: z.boolean().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Escapes ILIKE wildcards in operator-supplied search text (`\`, `%`, `_`). */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapDvpTradeRow(row: Record<string, unknown>): DvpTradeRow {
  const parsed = dvpTradeRowSchema.parse(row);
  return {
    id: parsed.id,
    organizationId: parsed.organization_id,
    projectId: parsed.project_id,
    swapDvp: address(parsed.swap_dvp),

    settlementAuthority: address(parsed.settlement_authority),
    userA: address(parsed.user_a),
    userB: address(parsed.user_b),
    mintA: address(parsed.mint_a),
    mintB: address(parsed.mint_b),
    // Stays a string all the way out. See the note in dvp-trade.repository.ts.
    nonce: parsed.nonce,

    tokenProgramA: address(parsed.token_program_a),
    decimalsA: parsed.decimals_a,
    decimalsB: parsed.decimals_b,
    closeSignature: parsed.close_signature === null ? null : signature(parsed.close_signature),
    closeResolutionAttempts: parsed.close_resolution_attempts,
    closeResolutionAfter: parsed.close_resolution_after,
    symbolA: parsed.symbol_a,
    symbolB: parsed.symbol_b,
    nameA: parsed.name_a,
    nameB: parsed.name_b,
    tokenProgramB: address(parsed.token_program_b),

    amountA: parsed.amount_a,
    amountB: parsed.amount_b,
    expiryTimestamp: parsed.expiry_timestamp,
    earliestSettlementTimestamp: parsed.earliest_settlement_timestamp,
    userASettlementDestination: address(parsed.user_a_settlement_destination),
    userBSettlementDestination: address(parsed.user_b_settlement_destination),
    refString: parsed.ref_string,

    escrowA: address(parsed.escrow_a),
    escrowB: address(parsed.escrow_b),

    counterpartyAccountIdA: parsed.counterparty_account_id_a,
    counterpartyAccountIdB: parsed.counterparty_account_id_b,

    status: parsed.status,
    observedAt: parsed.observed_at,
    idempotencyKey: parsed.idempotency_key,
    idempotencyFingerprint: parsed.idempotency_fingerprint,
    createSignature: parsed.create_signature === null ? null : signature(parsed.create_signature),
    createLastValidBlockHeight: parsed.create_last_valid_block_height,
    escrowAAmount: parsed.escrow_a_amount,
    escrowBAmount: parsed.escrow_b_amount,
    escrowAPeakAmount: parsed.escrow_a_peak_amount,
    escrowBPeakAmount: parsed.escrow_b_peak_amount,
    escrowAFrozen: parsed.escrow_a_frozen,
    escrowBFrozen: parsed.escrow_b_frozen,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

const SELECT_COLUMNS = `id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         decimals_a, decimals_b, symbol_a, symbol_b, name_a, name_b,
         amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
         user_a_settlement_destination, user_b_settlement_destination, ref_string,
         escrow_a, escrow_b, counterparty_account_id_a, counterparty_account_id_b,
         status, observed_at,
         idempotency_key, idempotency_fingerprint,
         create_signature, create_last_valid_block_height, close_signature,
         close_resolution_attempts, close_resolution_after,
         escrow_a_amount, escrow_b_amount, escrow_a_peak_amount, escrow_b_peak_amount,
         escrow_a_frozen, escrow_b_frozen,
         created_at, updated_at`;

/**
 * The wallet allowlist clause, as SQL plus its bindings. Empty means
 * "authorized for no wallet" (`1 = 0`, never a dropped clause); absent or
 * null is unrestricted. A bound wallet admits the trades it is a PARTY to —
 * the wallet ids join to `custody_wallets.public_key`, duplicated across the
 * two per-side IN subqueries.
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
  return {
    sql: ` AND (user_a IN (SELECT public_key FROM custody_wallets WHERE id IN (${placeholders}))
            OR user_b IN (SELECT public_key FROM custody_wallets WHERE id IN (${placeholders})))`,
    bindings: [...sdpWalletIds, ...sdpWalletIds],
  };
}

export function createPostgresDvpTradeRepository(db: AppDb): DvpTradeRepository {
  /**
   * Inserts a DvP claim through either the client or its transaction executor.
   *
   * @param executor - Database executor owning the statement.
   * @param row - Claim to insert.
   * @returns The inserted claim.
   */
  async function insert(executor: DatabaseExecutor, row: DvpTradeInsert): Promise<DvpTradeRow> {
    const inserted = await executor
      .prepare(
        `INSERT INTO dvp_trades (
              id, organization_id, project_id, swap_dvp,
              settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
              token_program_a, token_program_b,
              decimals_a, decimals_b, symbol_a, symbol_b, name_a, name_b,
              amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
              user_a_settlement_destination, user_b_settlement_destination, ref_string,
              escrow_a, escrow_b, counterparty_account_id_a, counterparty_account_id_b,
              idempotency_key, idempotency_fingerprint,
              create_signature, create_last_valid_block_height
            ) VALUES (
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?
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
        row.decimalsA,
        row.decimalsB,
        row.symbolA,
        row.symbolB,
        row.nameA,
        row.nameB,
        row.amountA,
        row.amountB,
        row.expiryTimestamp,
        row.earliestSettlementTimestamp,
        row.userASettlementDestination,
        row.userBSettlementDestination,
        row.refString,
        row.escrowA,
        row.escrowB,
        row.counterpartyAccountIdA,
        row.counterpartyAccountIdB,
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
  }

  return {
    async create(row: DvpTradeInsert) {
      return insert(db, row);
    },

    async claimWithKeyRelease(failedRowId: string | null, row: DvpTradeInsert) {
      return db.transaction(async (executor) => {
        if (failedRowId !== null) {
          await executor
            .prepare(
              `UPDATE dvp_trades
                  SET idempotency_key = NULL, updated_at = sdp_iso_now()
                WHERE id = ? AND status = 'create_failed' AND idempotency_key IS NOT NULL`
            )
            .bind(failedRowId)
            .run();
        }
        return insert(executor, row);
      });
    },

    async attachCreateSignature(
      id: string,
      createSignature: Signature,
      lastValidBlockHeight: string
    ) {
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET create_signature = ?,
                  create_last_valid_block_height = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'creating' AND create_signature IS NULL
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(createSignature, lastValidBlockHeight, id)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async resolveCreate(id: string, status: "created" | "create_failed") {
      // Both escrows are empty the instant the program creates them, so a trade
      // that has just landed does not need the sweep to tell us that. Without
      // this the first minute of every trade's life read "Not checked — nothing
      // has read this escrow", which is true of the reconciler and useless to a
      // person looking at a trade they created five seconds ago.
      // Compare-and-swap on 'creating'. A reconciler that already read the chain
      // and advanced the row has better information than this caller, so it wins
      // and we match zero rows rather than overwriting an observation.
      const observed = status === "created";
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET status = ?,
                  escrow_a_amount = CASE WHEN ? THEN '0' ELSE escrow_a_amount END,
                  escrow_b_amount = CASE WHEN ? THEN '0' ELSE escrow_b_amount END,
                  escrow_a_frozen = CASE WHEN ? THEN escrow_a_frozen ELSE escrow_a_frozen END,
                  observed_at = CASE WHEN ? THEN sdp_iso_now() ELSE observed_at END,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND status = 'creating'
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(status, observed, observed, observed, observed, id)
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
            WHERE status IN ('creating', 'created', 'partially_funded', 'funded', 'expired')
               OR (status IN ('settled', 'cancelled', 'rejected', 'closed_unknown')
                   AND closed_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '7 days')
            ORDER BY CASE WHEN status IN ('creating', 'created', 'partially_funded', 'funded', 'expired') THEN 0 ELSE 1 END,
                     observed_at ASC NULLS FIRST, created_at ASC, id ASC
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
                  escrow_a_peak_amount = CASE WHEN ?::text IN ('created', 'partially_funded', 'funded', 'expired') AND ?::text IS NOT NULL THEN GREATEST(COALESCE(escrow_a_peak_amount, '0')::numeric, ?::numeric)::text ELSE escrow_a_peak_amount END,
                  escrow_b_peak_amount = CASE WHEN ?::text IN ('created', 'partially_funded', 'funded', 'expired') AND ?::text IS NOT NULL THEN GREATEST(COALESCE(escrow_b_peak_amount, '0')::numeric, ?::numeric)::text ELSE escrow_b_peak_amount END,
                  close_signature = CASE WHEN close_signature IS NULL THEN ?::text ELSE close_signature END,
                  close_resolution_attempts = CASE WHEN ?::text IS NOT NULL AND ?::text IN ('settled', 'cancelled', 'rejected') THEN 0 ELSE close_resolution_attempts END,
                  close_resolution_after = CASE WHEN ?::text IS NOT NULL AND ?::text IN ('settled', 'cancelled', 'rejected') THEN NULL ELSE close_resolution_after END,
                  closed_at = CASE WHEN closed_at IS NULL AND ?::text IN ('settled', 'cancelled', 'rejected', 'closed_unknown') THEN sdp_iso_now() ELSE closed_at END,
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
          input.status,
          input.escrowAAmount,
          input.escrowAAmount,
          input.status,
          input.escrowBAmount,
          input.escrowBAmount,
          input.closeSignature,
          input.closeSignature,
          input.status,
          input.closeSignature,
          input.status,
          input.status,
          input.observedAt,
          input.id,
          input.expectedStatus
        )
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async deferCloseResolution(input) {
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET close_resolution_attempts = ?,
                  close_resolution_after = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ? AND status = ?
            RETURNING id`
        )
        .bind(input.attempts, input.after, input.id, input.expectedStatus)
        .first<Record<string, unknown>>();
      return row !== null && row !== undefined;
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

    async getBySwapDvp(scope: DvpTradeScope, swapDvp: Address) {
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

    async recordClose(id: string, status: "settled" | "cancelled", signature: Signature) {
      // Only from a status where the trade was still open. A row the reconciler
      // has already moved to a terminal state was decided by something that read
      // the chain, and that beats this caller's expectation.
      const row = await db
        .prepare(
          `UPDATE dvp_trades
              SET status = ?,
                  close_signature = ?,
                  closed_at = CASE WHEN closed_at IS NULL THEN sdp_iso_now() ELSE closed_at END,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND status IN ('created', 'partially_funded', 'funded', 'expired', 'closed_unknown')
            RETURNING ${SELECT_COLUMNS}`
        )
        .bind(status, signature, id)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async listByProject(scope: DvpTradeScope, filters: DvpTradeListFilters, limit: number) {
      const wallets = walletScopeClause(scope.sdpWalletIds);
      const clauses = ["organization_id = ?", "project_id = ?"];
      const bindings: unknown[] = [scope.organizationId, scope.projectId];

      // Composed with the scope predicates in the WHERE, before the LIMIT: the
      // list is capped with no cursor, so narrowing after the page would make a
      // matching trade older than the newest page unfindable.
      if (filters.statuses !== null) {
        const placeholders = filters.statuses.map(() => "?").join(", ");
        clauses.push(`status IN (${placeholders})`);
        bindings.push(...filters.statuses);
      }

      // Same semantics as the dashboard's `matchesAddressQuery`, as close as SQL
      // allows: case-insensitive substring over id, the on-chain account, both
      // parties, both escrows, both mints and both leg symbols. Wildcards in the
      // query are literal, and an ellipsis split is NOT offered — see the
      // divergence note in dvp-trade.repository.ts's sibling web module.
      if (filters.q !== null) {
        clauses.push(
          `(id ILIKE ? ESCAPE '\\'
             OR swap_dvp ILIKE ? ESCAPE '\\'
             OR user_a ILIKE ? ESCAPE '\\'
             OR user_b ILIKE ? ESCAPE '\\'
             OR escrow_a ILIKE ? ESCAPE '\\'
             OR escrow_b ILIKE ? ESCAPE '\\'
             OR mint_a ILIKE ? ESCAPE '\\'
             OR mint_b ILIKE ? ESCAPE '\\'
             OR symbol_a ILIKE ? ESCAPE '\\'
             OR symbol_b ILIKE ? ESCAPE '\\')`
        );
        const pattern = `%${escapeLikePattern(filters.q)}%`;
        bindings.push(
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern
        );
      }

      const result = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE ${clauses.join(" AND ")}${wallets.sql}
            ORDER BY created_at DESC
            LIMIT ?`
        )
        .bind(...bindings, ...wallets.bindings, limit)
        .all<Record<string, unknown>>();
      return result.results.map((row) => mapDvpTradeRow(row));
    },

    async getByIdAsParty(tradeId) {
      const row = await db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM dvp_trades WHERE id = ?`)
        .bind(tradeId)
        .first<Record<string, unknown>>();
      return row ? mapDvpTradeRow(row) : null;
    },

    async listInboundForParty(scope, limit) {
      // No addresses means no wallets, which means nothing can name this
      // caller. Returning early keeps an `IN ()` out of the SQL, which is a
      // syntax error in Postgres rather than an empty result.
      if (scope.partyAddresses.length === 0) {
        return [];
      }

      // Only statuses where the party can still do something. A settled or
      // cancelled trade naming you is history, and putting it in a list called
      // "waiting on you" would be false. `expired` is left out for the same
      // reason: nothing a party funds can settle after it.
      const placeholders = scope.partyAddresses.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT ${SELECT_COLUMNS}
             FROM dvp_trades
            WHERE status IN ('created', 'partially_funded', 'funded')
              AND project_id <> ?
              AND (user_a IN (${placeholders}) OR user_b IN (${placeholders}))
            ORDER BY created_at DESC
            LIMIT ?`
        )
        .bind(scope.projectId, ...scope.partyAddresses, ...scope.partyAddresses, limit)
        .all<Record<string, unknown>>();
      return result.results.map((row) => mapDvpTradeRow(row));
    },
  };
}
