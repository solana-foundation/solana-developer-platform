import type { WorkflowActionType, WorkflowExecutionStatus, WorkflowTriggerType } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateWorkflowExecutionId(): string {
  return `workflow_execution_${crypto.randomUUID()}`;
}

export interface WorkflowExecutionRow {
  id: string;
  organization_id: string;
  project_id: string;
  workflow_id: string;
  token_id: string;
  trigger_type: WorkflowTriggerType;
  action_type: WorkflowActionType;
  status: WorkflowExecutionStatus;
  idempotency_key: string;
  trigger_payload: Record<string, unknown>;
  result: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  locked_at: string | null;
  error: string | null;
  // The human who approved or rejected a held execution (null for auto-applied rows).
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkflowExecutionInput {
  organizationId: string;
  projectId: string;
  workflowId: string;
  tokenId: string;
  triggerType: WorkflowTriggerType;
  actionType: WorkflowActionType;
  // 'pending' (auto) or 'awaiting_review' (manual / requires-approval).
  status: Extract<WorkflowExecutionStatus, "pending" | "awaiting_review">;
  idempotencyKey: string;
  triggerPayload: Record<string, unknown>;
  maxAttempts: number;
}

export interface ListWorkflowExecutionsInput {
  organizationId: string;
  projectId: string;
  workflowId?: string;
  tokenId?: string;
  limit: number;
  offset: number;
}

export interface WorkflowExecutionsRepositoryContext {
  db: RepositoryDbClient;
}

export interface WorkflowExecutionsRepository {
  // Insert a durable execution; ON CONFLICT(workflow_id, idempotency_key) DO NOTHING.
  // Returns null when the event was already enqueued (re-delivered webhook).
  createExecution(input: CreateWorkflowExecutionInput): Promise<WorkflowExecutionRow | null>;
  getExecutionById(params: {
    executionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WorkflowExecutionRow | null>;
  listExecutions(
    params: ListWorkflowExecutionsInput
  ): Promise<{ rows: WorkflowExecutionRow[]; total: number }>;

  // ── Engine (cron) ──
  // Recover stale 'processing' rows (a prior tick died mid-flight). Rows whose action
  // type is in `parkActionTypes` (approval-gated / non-idempotent) are NOT blindly
  // re-dispatched — we cannot know whether the interrupted side effect landed — they
  // park as 'failed' (STALE_RECOVERED_NEEDS_REVIEW) for a human to re-approve. All
  // other rows go back to 'pending'. Both updates are bounded by `limit`.
  recoverStaleProcessing(params: {
    staleBefore: string;
    limit: number;
    parkActionTypes: readonly WorkflowActionType[];
  }): Promise<{ recovered: number; parked: WorkflowExecutionRow[] }>;
  // Due + retryable 'pending' rows under the attempt cap.
  listDueExecutions(params: { dueBefore: string; limit: number }): Promise<WorkflowExecutionRow[]>;
  // Optimistic claim: pending → processing, attempt_count += 1. Returns the claimed row or null.
  claimExecution(params: { executionId: string }): Promise<WorkflowExecutionRow | null>;
  completeExecution(params: {
    executionId: string;
    result: Record<string, unknown>;
  }): Promise<void>;
  failExecution(params: {
    executionId: string;
    error: string;
    result?: Record<string, unknown>;
  }): Promise<void>;
  rescheduleExecution(params: {
    executionId: string;
    error: string;
    nextAttemptAt: string;
  }): Promise<void>;

  // ── Human decisions ──
  // Approve and retry are deliberately separate verbs. Approving authorizes an action
  // that has never run; retrying re-attempts one that already failed. Only the first is
  // an authorization event, and conflating them made the audit trail unable to say which
  // happened. Both reset attempt_count so an attempts-exhausted row is actually runnable
  // again, and both record who decided.
  //
  // Approve: awaiting_review → pending.
  approveExecution(params: WorkflowDecisionInput): Promise<WorkflowExecutionRow | null>;
  // Retry: failed → pending.
  retryExecution(params: WorkflowDecisionInput): Promise<WorkflowExecutionRow | null>;
  // Reject a held execution: awaiting_review → cancelled (a human declined the action).
  cancelExecution(params: WorkflowDecisionInput): Promise<WorkflowExecutionRow | null>;

  // Cancel everything a rule has in flight (awaiting_review + pending). Called when the
  // rule is disabled or deleted: a held mint from a rule someone just turned off should
  // not stay sitting in the approval queue waiting to be authorized.
  cancelOpenExecutionsForWorkflow(params: {
    workflowId: string;
    organizationId: string;
    projectId: string;
  }): Promise<number>;
}

export interface WorkflowDecisionInput {
  executionId: string;
  organizationId: string;
  projectId: string;
  // Scopes the decision to the token in the request path, so a per-token audit trail
  // can't be written against an execution belonging to a different asset.
  tokenId: string;
  decidedBy: string;
}
