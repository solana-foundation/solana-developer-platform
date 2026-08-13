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
  // Called once the version is gone from the backend.
  deleteRetirement(id: string): Promise<void>;
  // Another failed attempt: records the reason and pushes the next try out.
  rescheduleRetirement(params: { id: string; error: string; nextAttemptAt: string }): Promise<void>;
}

export interface WorkflowSecretRetirementsRepositoryContext {
  db: RepositoryDbClient;
}
