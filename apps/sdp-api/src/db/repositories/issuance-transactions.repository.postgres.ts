import type { DatabaseExecutor } from "@/db";
import type { IssuanceTransactionsRepository } from "./issuance-transactions.repository";

interface IssuanceTransactionPollRow {
  id: string;
  organization_id: string;
  signature: string;
  slot: number | null;
  finalization_last_polled_at: string | null;
}

export function createPostgresIssuanceTransactionsRepository(
  db: DatabaseExecutor
): IssuanceTransactionsRepository {
  return {
    async listConfirmedTransactionsToPoll({ limit }) {
      const rows = await db
        .prepare(
          `SELECT it.id, it.organization_id, it.signature, it.slot,
                  it.finalization_last_polled_at
           FROM issuance_transactions it
           WHERE it.status = 'confirmed'
             AND it.signature IS NOT NULL
             AND (it.finalization_next_poll_at IS NULL
                  OR it.finalization_next_poll_at <= sdp_iso_now())
           ORDER BY it.finalization_next_poll_at ASC NULLS FIRST, it.id ASC
           LIMIT ?`
        )
        .bind(limit)
        .all<IssuanceTransactionPollRow>();

      return rows.results.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        signature: row.signature,
        slot: row.slot,
        lastPolledAt: row.finalization_last_polled_at,
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
      // it instead of duplicating its status history. Every deferral
      // decision is stamped-guarded: it applies only while the row's poll
      // stamp is unchanged since the verdict's page was read, so overlapping
      // ticks that selected the same due row never overwrite each other's
      // scheduling. A provisional verdict grows the row's backoff
      // (finalization_poll_attempts, capped at one re-check per 24h). A
      // failed read (read_failed, nothing learned about finality) grows
      // neither the counter nor the deferral: it re-dues the row at the poll
      // time, which rotates the failed page behind the rest of the due queue
      // so a sustained outage cannot pin the same 256 rows at the front
      // while later rows wait. A signature that never finalizes — one lost
      // to a fork — is due again after 5m * 2^finalization_poll_attempts
      // instead of every tick, while the recovery path stays intact.
      const result = await db
        .prepare(
          `WITH advanced AS (
             UPDATE issuance_transactions AS it
                SET status = CASE WHEN v.finalized THEN 'finalized' ELSE it.status END,
                    slot = CASE WHEN v.finalized THEN COALESCE(it.slot, v.slot) ELSE it.slot END,
                    updated_at = CASE WHEN v.finalized THEN ? ELSE it.updated_at END,
                    finalization_last_polled_at = ?,
                    finalization_poll_attempts = CASE
                      WHEN v.finalized THEN 0
                      WHEN v.read_failed THEN it.finalization_poll_attempts
                      WHEN it.finalization_last_polled_at IS NOT DISTINCT FROM v.observed_last_polled_at
                        THEN it.finalization_poll_attempts + 1
                      ELSE it.finalization_poll_attempts
                    END,
                    finalization_next_poll_at = CASE
                      WHEN v.finalized THEN NULL
                      WHEN v.read_failed
                           AND it.finalization_last_polled_at IS NOT DISTINCT FROM v.observed_last_polled_at
                        THEN to_char(
                          timezone('UTC', ?::timestamptz),
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        )
                      WHEN it.finalization_last_polled_at IS NOT DISTINCT FROM v.observed_last_polled_at
                        THEN to_char(
                          timezone('UTC', ?::timestamptz + make_interval(secs => LEAST(
                            86400,
                            300 * POWER(2, LEAST(it.finalization_poll_attempts, 17))
                          ))),
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        )
                      ELSE it.finalization_next_poll_at
                    END
               FROM jsonb_to_recordset(?::jsonb) AS v(
                 id text, organization_id text, finalized boolean,
                 read_failed boolean, observed_last_polled_at text, slot bigint
               )
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
          updatedAt,
          updatedAt,
          JSON.stringify(
            polled.map((t) => ({
              id: t.id,
              organization_id: t.organizationId,
              finalized: t.finalized,
              read_failed: t.readFailed,
              observed_last_polled_at: t.observedLastPolledAt,
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
