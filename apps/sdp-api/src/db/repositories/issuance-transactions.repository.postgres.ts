import type { DatabaseExecutor } from "@/db";
import type { IssuanceTransactionsRepository } from "./issuance-transactions.repository";

interface IssuanceTransactionPollRow {
  id: string;
  organization_id: string;
  signature: string;
  slot: number | null;
}

export function createPostgresIssuanceTransactionsRepository(
  db: DatabaseExecutor
): IssuanceTransactionsRepository {
  return {
    async listConfirmedTransactionsToPoll({ limit }) {
      const rows = await db
        .prepare(
          `SELECT it.id, it.organization_id, it.signature, it.slot
           FROM issuance_transactions it
           WHERE it.status = 'confirmed'
             AND it.signature IS NOT NULL
           ORDER BY it.finalization_last_polled_at ASC NULLS FIRST, it.id ASC
           LIMIT ?`
        )
        .bind(limit)
        .all<IssuanceTransactionPollRow>();

      return rows.results.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        signature: row.signature,
        slot: row.slot,
      }));
    },

    async advanceConfirmedTransactions({ polled, updatedAt }) {
      if (polled.length === 0) {
        return { advancedTransactionIds: [] };
      }

      // One statement so the history append sees exactly the rows this
      // statement advanced: the guarded UPDATE returns each row with its
      // post-update status, and the history insert filters on it — a polled
      // row the cluster still reports provisional only rotates its poll
      // stamp and never gains a false terminal history entry, and a
      // concurrent tick that already finalized a row makes this a no-op for
      // it instead of duplicating its status history.
      const result = await db
        .prepare(
          `WITH advanced AS (
             UPDATE issuance_transactions AS it
                SET status = CASE WHEN v.finalized THEN 'finalized' ELSE it.status END,
                    slot = CASE WHEN v.finalized THEN COALESCE(it.slot, v.slot) ELSE it.slot END,
                    updated_at = CASE WHEN v.finalized THEN ? ELSE it.updated_at END,
                    finalization_last_polled_at = ?
               FROM jsonb_to_recordset(?::jsonb) AS v(id text, organization_id text, finalized boolean, slot bigint)
              WHERE it.id = v.id
                AND it.organization_id = v.organization_id
                AND it.status = 'confirmed'
              RETURNING it.id, it.status AS final_status
           )
           INSERT INTO issuance_transaction_statuses (id, transaction_id, status, changed_at)
           SELECT 'its_' || replace(gen_random_uuid()::text, '-', ''), a.id, 'finalized', ?
           FROM advanced a
           WHERE a.final_status = 'finalized'
           RETURNING transaction_id`
        )
        .bind(
          updatedAt,
          updatedAt,
          JSON.stringify(
            polled.map((t) => ({
              id: t.id,
              organization_id: t.organizationId,
              finalized: t.finalized,
              slot: t.slot,
            }))
          ),
          updatedAt
        )
        .all<{ transaction_id: string }>();

      return {
        advancedTransactionIds: result.results.map((row) => row.transaction_id),
      };
    },
  };
}
