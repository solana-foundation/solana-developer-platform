import type { RepositoryDbClient } from "./base";

export interface WorkflowSecretRetirementRow {
  id: string;
  organization_id: string;
  workflow_id: string | null;
  storage_backend: string;
  secret_ref: string | null;
  secret_version_ref: string;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}

export interface RecordWorkflowSecretRetirementInput {
  organizationId: string;
  workflowId: string | null;
  storageBackend: string;
  secretRef: string | null;
  secretVersionRef: string;
  error: string;
  /**
   * When the sweeper may first act on this row, ISO-8601.
   *
   * Omit for an obligation that is due the moment it is recorded — a version
   * already orphaned by a committed write. Supply a future time for a
   * PROVISIONAL obligation, recorded before the write that would reference the
   * version: the row must exist in case that write never lands, but until the
   * request has had its chance to commit, acting on it would destroy a version
   * the transaction is about to make live.
   *
   * On conflict this is applied only when supplied, so re-reporting a version
   * never resets a backoff the sweeper is serving.
   */
  nextAttemptAt?: string | null;
}

// Durable queue of secret versions whose destroy call failed. Not tenant-scoped: the
// sweeper runs as the system, and a retirement outlives the tenant rows it came from.
export interface WorkflowSecretRetirementsRepository {
  // Idempotent on `secret_version_ref` — the same failed retirement can be reported by a
  // later request (or a retried one) without queueing the work twice.
  recordRetirement(input: RecordWorkflowSecretRetirementInput): Promise<void>;
  // Discharges an obligation recorded by the write that created it, once the version is
  // actually gone. Keyed on the ref because the writer never sees the row's id.
  deleteRetirementByVersionRef(secretVersionRef: string): Promise<void>;
  // Whether anything is still going to collect this version. Only used to tell an
  // operator the truth when a later write fails: the obligation is normally already on
  // record, so "this write failed" is not the same as "nothing will retry".
  hasRetirement(secretVersionRef: string): Promise<boolean>;
  listDueRetirements(params: {
    dueBefore: string;
    limit: number;
  }): Promise<WorkflowSecretRetirementRow[]>;
  /**
   * Take ownership of a due row BEFORE destroying its version — an optimistic
   * claim against the `attempt_count` that was read, the same shape workflow
   * executions use.
   *
   * Destroying is an external side effect that cannot join a transaction, so
   * the row is the token that decides who may do it. Between listing a row and
   * destroying it, the transaction that references the version can commit and
   * cancel the obligation; without this claim the sweeper would then destroy a
   * version that live credential rows point at. Claiming first makes the two
   * mutually exclusive: cancellation refuses a claimed row, and a claim refuses
   * a cancelled one.
   *
   * Pushes `next_attempt_at` out at the same time, so a process that dies
   * mid-destroy leaves the row to be retried on the backoff rather than spun on
   * every tick.
   *
   * @returns Whether this caller won the row.
   */
  claimRetirement(params: {
    id: string;
    expectedAttemptCount: number;
    nextAttemptAt: string;
  }): Promise<boolean>;
  // Called once the version is gone from the backend.
  deleteRetirement(id: string): Promise<void>;
  // The claim already counted the attempt and set the next one; this only
  // records why it failed.
  recordRetirementFailure(params: { id: string; error: string }): Promise<void>;
}

export interface WorkflowSecretRetirementsRepositoryContext {
  db: RepositoryDbClient;
}
