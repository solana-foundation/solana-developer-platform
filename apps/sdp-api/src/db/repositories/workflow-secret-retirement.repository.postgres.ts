import type { AppDb } from "@/db";
import type {
  RecordWorkflowSecretRetirementInput,
  WorkflowSecretRetirementRow,
  WorkflowSecretRetirementsRepository,
} from "./workflow-secret-retirement.repository";

function mapRow(row: Record<string, unknown>): WorkflowSecretRetirementRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    workflow_id: (row.workflow_id as string | null) ?? null,
    storage_backend: row.storage_backend as string,
    secret_ref: (row.secret_ref as string | null) ?? null,
    secret_version_ref: row.secret_version_ref as string,
    attempt_count: Number(row.attempt_count),
    last_error: (row.last_error as string | null) ?? null,
    next_attempt_at: row.next_attempt_at as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// The insert on its own, runnable on any executor — the pool, or a transaction another
// repository owns. Deleting a rule (or rotating its key) and recording that the old
// credential still needs destroying have to commit TOGETHER: recorded afterwards, the
// record is lost exactly when the database is the thing failing, and the sweeper reads
// nothing else, so the version stays readable in the backend with nothing to retry it.
export async function insertWorkflowSecretRetirement(
  exec: Pick<AppDb, "prepare">,
  input: RecordWorkflowSecretRetirementInput
): Promise<void> {
  // ON CONFLICT refreshes the reason rather than inserting a duplicate: the version
  // is already queued, and the newest failure is the useful one. `attempt_count` is
  // left alone — it counts sweeper attempts, not reports.
  //
  // `next_attempt_at` is written only when the caller names one, so a report arriving
  // while the sweeper is backing a row off cannot pull it forward — but a caller that
  // DOES name one overrides whatever stands, which is how a provisional row's grace
  // period is revoked the moment its version is known to be orphaned.
  await exec
    .prepare(
      `INSERT INTO workflow_action_secret_retirements
         (id, organization_id, workflow_id, storage_backend, secret_ref, secret_version_ref,
          last_error, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, sdp_iso_now()))
       ON CONFLICT (secret_version_ref) DO UPDATE
         SET last_error = EXCLUDED.last_error,
             next_attempt_at = COALESCE(?, workflow_action_secret_retirements.next_attempt_at),
             updated_at = sdp_iso_now()`
    )
    .bind(
      `wf_secret_retirement_${crypto.randomUUID()}`,
      input.organizationId,
      input.workflowId,
      input.storageBackend,
      input.secretRef,
      input.secretVersionRef,
      input.error,
      input.nextAttemptAt ?? null,
      input.nextAttemptAt ?? null
    )
    .run();
}

// The counterpart, likewise runnable inside another repository's transaction: a write
// that COMMITS a reference to a version cancels the obligation to destroy it, atomically.
// That is what lets the obligation be recorded before the reference exists — the only
// ordering in which a rejected write cannot leave a credential nobody knows about.
export async function deleteWorkflowSecretRetirement(
  exec: Pick<AppDb, "prepare">,
  secretVersionRef: string
): Promise<boolean> {
  const row = await exec
    .prepare(
      `DELETE FROM workflow_action_secret_retirements
        WHERE secret_version_ref = ?
        RETURNING secret_version_ref`
    )
    .bind(secretVersionRef)
    .first<{ secret_version_ref: string }>();
  return Boolean(row);
}

/**
 * Cancel an obligation ONLY while no sweeper has taken it — the other half of
 * `claimRetirement`.
 *
 * `attempt_count` counts sweeper attempts, so zero means no sweeper has ever
 * acted on this version and the version is certainly still there. A non-zero
 * count means one is already committed to destroying it (or has), and a
 * transaction about to reference the version must not proceed: it would commit
 * live rows pointing at a secret that is being destroyed out from under them.
 *
 * @returns Whether the obligation was cancelled. False means "do not commit".
 */
export async function cancelUnclaimedWorkflowSecretRetirement(
  exec: Pick<AppDb, "prepare">,
  secretVersionRef: string
): Promise<boolean> {
  const row = await exec
    .prepare(
      `DELETE FROM workflow_action_secret_retirements
        WHERE secret_version_ref = ? AND attempt_count = 0
        RETURNING secret_version_ref`
    )
    .bind(secretVersionRef)
    .first<{ secret_version_ref: string }>();
  return Boolean(row);
}

export function createPostgresWorkflowSecretRetirementsRepository(
  db: AppDb
): WorkflowSecretRetirementsRepository {
  return {
    async recordRetirement(input: RecordWorkflowSecretRetirementInput) {
      await insertWorkflowSecretRetirement(db, input);
    },

    async deleteRetirementByVersionRef(secretVersionRef: string) {
      await deleteWorkflowSecretRetirement(db, secretVersionRef);
    },

    async hasRetirement(secretVersionRef: string) {
      const row = await db
        .prepare("SELECT 1 FROM workflow_action_secret_retirements WHERE secret_version_ref = ?")
        .bind(secretVersionRef)
        .first<Record<string, unknown>>();
      return row !== null;
    },

    async listDueRetirements(params) {
      const result = await db
        .prepare(
          `SELECT * FROM workflow_action_secret_retirements
             WHERE next_attempt_at <= ?
             ORDER BY next_attempt_at ASC
             LIMIT ?`
        )
        .bind(params.dueBefore, params.limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async deleteRetirement(id: string) {
      await db
        .prepare("DELETE FROM workflow_action_secret_retirements WHERE id = ?")
        .bind(id)
        .run();
    },

    async claimRetirement(params) {
      // Compare-and-swap on the attempt count that was read: a second sweeper,
      // or a transaction that cancelled the obligation, makes this match zero
      // rows rather than let two parties act on one version.
      const row = await db
        .prepare(
          `UPDATE workflow_action_secret_retirements
             SET attempt_count = attempt_count + 1,
                 next_attempt_at = ?,
                 updated_at = sdp_iso_now()
           WHERE id = ? AND attempt_count = ?
           RETURNING id`
        )
        .bind(params.nextAttemptAt, params.id, params.expectedAttemptCount)
        .first<{ id: string }>();
      return Boolean(row);
    },

    async recordRetirementFailure(params) {
      await db
        .prepare(
          `UPDATE workflow_action_secret_retirements
             SET last_error = ?, updated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(params.error, params.id)
        .run();
    },
  };
}
