import { type Address, address, type Signature, signature } from "@solana/kit";
import type { AppDb } from "@/db";
import type {
  DvpTradeInsert,
  DvpTradeListFilters,
  DvpTradeObservationUpdate,
  DvpTradeRepository,
  DvpTradeRow,
  DvpTradeScope,
  DvpTradeStatus,
} from "./dvp-trade.repository";

/**
 * Asserts a DB column is a string, throwing if it is missing.
 *
 * Used for plain-string columns only. Address and signature columns are branded
 * with {@link address} / {@link signature} directly — those throw on malformed
 * values, which is correct: a bad value in an address column is DB corruption
 * and must fail loudly, not flow.
 */
function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`DvP trade ${field} is missing`);
  }
  return value;
}

/** Escapes ILIKE wildcards in operator-supplied search text (`\`, `%`, `_`). */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapDvpTradeRow(row: Record<string, unknown>): DvpTradeRow {
  return {
    id: assertString(row.id, "id"),
    organizationId: assertString(row.organization_id, "organization_id"),
    projectId: assertString(row.project_id, "project_id"),
    swapDvp: address(assertString(row.swap_dvp, "swap_dvp")),

    settlementAuthority: address(assertString(row.settlement_authority, "settlement_authority")),
    userA: address(assertString(row.user_a, "user_a")),
    userB: address(assertString(row.user_b, "user_b")),
    mintA: address(assertString(row.mint_a, "mint_a")),
    mintB: address(assertString(row.mint_b, "mint_b")),
    // Stays a string all the way out. See the note in dvp-trade.repository.ts.
    nonce: assertString(row.nonce, "nonce"),

    tokenProgramA: address(assertString(row.token_program_a, "token_program_a")),
    decimalsA: typeof row.decimals_a === "number" ? row.decimals_a : null,
    decimalsB: typeof row.decimals_b === "number" ? row.decimals_b : null,
    closeSignature: typeof row.close_signature === "string" ? signature(row.close_signature) : null,
    symbolA: typeof row.symbol_a === "string" ? row.symbol_a : null,
    symbolB: typeof row.symbol_b === "string" ? row.symbol_b : null,
    tokenProgramB: address(assertString(row.token_program_b, "token_program_b")),

    amountA: assertString(row.amount_a, "amount_a"),
    amountB: assertString(row.amount_b, "amount_b"),
    expiryTimestamp: assertString(row.expiry_timestamp, "expiry_timestamp"),
    earliestSettlementTimestamp:
      typeof row.earliest_settlement_timestamp === "string"
        ? row.earliest_settlement_timestamp
        : null,
    userASettlementDestination: address(
      assertString(row.user_a_settlement_destination, "user_a_settlement_destination")
    ),
    userBSettlementDestination: address(
      assertString(row.user_b_settlement_destination, "user_b_settlement_destination")
    ),
    refString: typeof row.ref_string === "string" ? row.ref_string : null,

    escrowA: address(assertString(row.escrow_a, "escrow_a")),
    escrowB: address(assertString(row.escrow_b, "escrow_b")),

    counterpartyAccountIdA:
      typeof row.counterparty_account_id_a === "string" ? row.counterparty_account_id_a : null,
    counterpartyAccountIdB:
      typeof row.counterparty_account_id_b === "string" ? row.counterparty_account_id_b : null,

    status: row.status as DvpTradeStatus,
    observedAt: typeof row.observed_at === "string" ? row.observed_at : null,
    idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    idempotencyFingerprint:
      typeof row.idempotency_fingerprint === "string" ? row.idempotency_fingerprint : null,
    createSignature:
      typeof row.create_signature === "string" ? signature(row.create_signature) : null,
    createLastValidBlockHeight:
      typeof row.create_last_valid_block_height === "string"
        ? row.create_last_valid_block_height
        : null,
    escrowAAmount: typeof row.escrow_a_amount === "string" ? row.escrow_a_amount : null,
    escrowBAmount: typeof row.escrow_b_amount === "string" ? row.escrow_b_amount : null,
    escrowAPeakAmount:
      typeof row.escrow_a_peak_amount === "string" ? row.escrow_a_peak_amount : null,
    escrowBPeakAmount:
      typeof row.escrow_b_peak_amount === "string" ? row.escrow_b_peak_amount : null,
    escrowAFrozen: typeof row.escrow_a_frozen === "boolean" ? row.escrow_a_frozen : null,
    escrowBFrozen: typeof row.escrow_b_frozen === "boolean" ? row.escrow_b_frozen : null,
    createdAt: assertString(row.created_at, "created_at"),
    updatedAt: assertString(row.updated_at, "updated_at"),
  };
}

const SELECT_COLUMNS = `id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         decimals_a, decimals_b, symbol_a, symbol_b,
         amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
         user_a_settlement_destination, user_b_settlement_destination, ref_string,
         escrow_a, escrow_b, counterparty_account_id_a, counterparty_account_id_b,
         status, observed_at,
         idempotency_key, idempotency_fingerprint,
         create_signature, create_last_valid_block_height, close_signature,
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
  return {
    async create(row: DvpTradeInsert) {
      const inserted = await db
        .prepare(
          `INSERT INTO dvp_trades (
              id, organization_id, project_id, swap_dvp,
              settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
              token_program_a, token_program_b,
              decimals_a, decimals_b, symbol_a, symbol_b,
              amount_a, amount_b, expiry_timestamp, earliest_settlement_timestamp,
              user_a_settlement_destination, user_b_settlement_destination, ref_string,
              escrow_a, escrow_b, counterparty_account_id_a, counterparty_account_id_b,
              idempotency_key, idempotency_fingerprint,
              create_signature, create_last_valid_block_height
            ) VALUES (
              ?, ?, ?, ?,
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

    async listOpenForReconciliation(limit: number, environment) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("listOpenForReconciliation limit must be an integer from 1 to 256");
      }
      // Stalest first, never-observed before that, so a busy cluster cannot
      // starve the trades nothing is known about.
      const result = await db
        .prepare(
          `SELECT t.*
             FROM dvp_trades t
             JOIN projects p ON p.id = t.project_id AND p.environment = ?
            WHERE t.status IN ('creating', 'created', 'partially_funded', 'funded', 'expired')
               OR (t.status IN ('settled', 'cancelled', 'rejected', 'closed_unknown')
                   AND t.closed_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '7 days')
            ORDER BY CASE WHEN t.status IN ('creating', 'created', 'partially_funded', 'funded', 'expired') THEN 0 ELSE 1 END,
                     t.observed_at ASC NULLS FIRST, t.created_at ASC, t.id ASC
            LIMIT ?`
        )
        .bind(environment, limit)
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
          input.status,
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
