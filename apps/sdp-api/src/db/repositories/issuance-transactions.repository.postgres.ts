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
    async listConfirmedTransactionsToPoll({ confirmedAfter, limit }) {
      const rows = await db
        .prepare(
          `SELECT it.id, it.organization_id, it.signature, it.slot
           FROM issuance_transactions it
           WHERE it.status = 'confirmed'
             AND it.signature IS NOT NULL
             AND COALESCE(
                   (SELECT MAX(st.changed_at)
                      FROM issuance_transaction_statuses st
                     WHERE st.transaction_id = it.id
                       AND st.status = 'confirmed'),
                   it.updated_at
                 ) > ?
           ORDER BY it.finalization_last_polled_at ASC NULLS FIRST, it.id ASC
           LIMIT ?`
        )
        .bind(confirmedAfter, limit)
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
        return;
      }

      // One statement so the history append sees exactly the rows this
      // statement advanced: the guarded UPDATE returns them, and a concurrent
      // tick that already finalized a row makes this a no-op for it instead of
      // duplicating its status history.
      await db
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
              RETURNING it.id
           )
           INSERT INTO issuance_transaction_statuses (id, transaction_id, status, changed_at)
           SELECT 'its_' || replace(gen_random_uuid()::text, '-', ''), a.id, 'finalized', ?
           FROM advanced a`
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
        .run();
    },
  };
}
