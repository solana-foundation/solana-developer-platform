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

  // Manual retry: failed | awaiting_review → pending (picked up next cron pass).
  // Resets attempt_count so an attempts-exhausted execution is actually re-runnable.
  retryExecution(params: {
    executionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WorkflowExecutionRow | null>;
  // Reject a held execution: awaiting_review → cancelled (a human declined the action).
  cancelExecution(params: {
    executionId: string;
    organizationId: string;
    projectId: string;
  }): Promise<WorkflowExecutionRow | null>;
}
