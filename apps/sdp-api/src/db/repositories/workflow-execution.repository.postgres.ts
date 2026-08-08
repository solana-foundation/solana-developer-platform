import type { WorkflowActionType, WorkflowExecutionStatus, WorkflowTriggerType } from "@sdp/types";
import type { AppDb } from "@/db";
import {
  type CreateWorkflowExecutionInput,
  generateWorkflowExecutionId,
  type ListWorkflowExecutionsInput,
  type WorkflowDecisionInput,
  type WorkflowExecutionRow,
  type WorkflowExecutionsRepository,
} from "./workflow-execution.repository";

function mapExecutionRow(row: Record<string, unknown>): WorkflowExecutionRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    workflow_id: row.workflow_id as string,
    token_id: row.token_id as string,
    trigger_type: row.trigger_type as WorkflowTriggerType,
    action_type: row.action_type as WorkflowActionType,
    status: row.status as WorkflowExecutionStatus,
    idempotency_key: row.idempotency_key as string,
    trigger_payload: (row.trigger_payload as Record<string, unknown>) ?? {},
    result: (row.result as Record<string, unknown>) ?? {},
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: (row.next_attempt_at as string | null) ?? null,
    locked_at: (row.locked_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    decided_by: (row.decided_by as string | null) ?? null,
    decided_at: (row.decided_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function getById(
  db: AppDb,
  params: { executionId: string; organizationId: string; projectId: string }
): Promise<WorkflowExecutionRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM workflow_executions WHERE id = ? AND organization_id = ? AND project_id = ?`
    )
    .bind(params.executionId, params.organizationId, params.projectId)
    .first<Record<string, unknown>>();
  return row ? mapExecutionRow(row) : null;
}

export function createPostgresWorkflowExecutionsRepository(
  db: AppDb
): WorkflowExecutionsRepository {
  return {
    async createExecution(input: CreateWorkflowExecutionInput) {
      const id = generateWorkflowExecutionId();
      // ON CONFLICT DO NOTHING makes re-delivered events no-ops; RETURNING is empty on conflict.
      const inserted = await db
        .prepare(
          `INSERT INTO workflow_executions (
             id, organization_id, project_id, workflow_id, token_id, trigger_type, action_type,
             status, idempotency_key, trigger_payload, max_attempts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
           ON CONFLICT (workflow_id, idempotency_key) DO NOTHING
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.workflowId,
          input.tokenId,
          input.triggerType,
          input.actionType,
          input.status,
          input.idempotencyKey,
          JSON.stringify(input.triggerPayload),
          input.maxAttempts
        )
        .first<Record<string, unknown>>();

      return inserted ? mapExecutionRow(inserted) : null;
    },

    getExecutionById(params) {
      return getById(db, params);
    },

    async listExecutions(params: ListWorkflowExecutionsInput) {
      const filters: string[] = ["organization_id = ?", "project_id = ?"];
      const bindings: Array<string | number> = [params.organizationId, params.projectId];
      if (params.workflowId) {
        filters.push("workflow_id = ?");
        bindings.push(params.workflowId);
      }
      if (params.tokenId) {
        filters.push("token_id = ?");
        bindings.push(params.tokenId);
      }
      const where = filters.join(" AND ");

      const rowsResult = await db
        .prepare(
          `SELECT * FROM workflow_executions WHERE ${where}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
        )
        .bind(...bindings, params.limit, params.offset)
        .all<Record<string, unknown>>();

      const totalRow = await db
        .prepare(`SELECT COUNT(*)::int AS total FROM workflow_executions WHERE ${where}`)
        .bind(...bindings)
        .first<{ total: number }>();

      return { rows: rowsResult.results.map(mapExecutionRow), total: totalRow?.total ?? 0 };
    },

    async recoverStaleProcessing(params) {
      // Non-idempotent (approval-gated) actions park as failed — the interrupted side
      // effect may have landed, so a human must inspect and explicitly re-approve.
      const parkTypes = [...params.parkActionTypes];
      const parkedResult = await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'failed', error = 'STALE_RECOVERED_NEEDS_REVIEW',
                 locked_at = NULL, next_attempt_at = NULL, updated_at = sdp_iso_now()
           WHERE id IN (
             SELECT id FROM workflow_executions
              WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at <= ?
                AND action_type = ANY(?::text[])
              ORDER BY locked_at ASC
              LIMIT ?
           )
           RETURNING *`
        )
        .bind(params.staleBefore, parkTypes, params.limit)
        .all<Record<string, unknown>>();

      // A crashed tick isn't the action's fault — refund the attempt the claim
      // consumed so recovery doesn't eat into max_attempts.
      const recovered = await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'pending', locked_at = NULL,
                 attempt_count = GREATEST(attempt_count - 1, 0), updated_at = sdp_iso_now()
           WHERE id IN (
             SELECT id FROM workflow_executions
              WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at <= ?
                AND NOT (action_type = ANY(?::text[]))
              ORDER BY locked_at ASC
              LIMIT ?
           )`
        )
        .bind(params.staleBefore, parkTypes, params.limit)
        .run();

      return { recovered, parked: parkedResult.results.map(mapExecutionRow) };
    },

    async listDueExecutions(params) {
      const result = await db
        .prepare(
          `SELECT * FROM workflow_executions
             WHERE status = 'pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND attempt_count < max_attempts
             ORDER BY created_at ASC
             LIMIT ?`
        )
        .bind(params.dueBefore, params.limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapExecutionRow);
    },

    async claimExecution(params) {
      // Guarded claim: only one worker wins pending → processing.
      const row = await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'processing',
                 locked_at = sdp_iso_now(),
                 attempt_count = attempt_count + 1,
                 updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'pending'
           RETURNING *`
        )
        .bind(params.executionId)
        .first<Record<string, unknown>>();
      return row ? mapExecutionRow(row) : null;
    },

    // Terminal writes carry `AND status = 'processing'`. Without it, a tick that
    // overran the stale-recovery window would write its verdict over a row another
    // tick had already re-claimed — the second run's result silently lost.
    async completeExecution(params) {
      await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'succeeded', result = ?::jsonb, error = NULL,
                 locked_at = NULL, next_attempt_at = NULL, updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'processing'`
        )
        .bind(JSON.stringify(params.result), params.executionId)
        .run();
    },

    async failExecution(params) {
      await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'failed', error = ?,
                 result = COALESCE(?::jsonb, result),
                 locked_at = NULL, next_attempt_at = NULL, updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'processing'`
        )
        .bind(
          params.error,
          params.result ? JSON.stringify(params.result) : null,
          params.executionId
        )
        .run();
    },

    async rescheduleExecution(params) {
      await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'pending', error = ?, next_attempt_at = ?,
                 locked_at = NULL, updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'processing'`
        )
        .bind(params.error, params.nextAttemptAt, params.executionId)
        .run();
    },

    // attempt_count resets to 0 on both decisions: a human explicitly authorized the
    // run, and listDueExecutions skips rows at the attempt cap — without the reset an
    // attempts-exhausted execution would sit in 'pending' forever.
    async approveExecution(params) {
      return decide(db, params, "awaiting_review", "pending");
    },

    async retryExecution(params) {
      return decide(db, params, "failed", "pending");
    },

    async cancelExecution(params) {
      return decide(db, params, "awaiting_review", "cancelled");
    },

    async cancelOpenExecutionsForWorkflow(params) {
      // 'processing' rows are deliberately left alone: they are mid-flight on a worker
      // and the stale-recovery path already decides what happens to them.
      return await db
        .prepare(
          `UPDATE workflow_executions
             SET status = 'cancelled', next_attempt_at = NULL, locked_at = NULL,
                 error = 'RULE_WITHDRAWN', updated_at = sdp_iso_now()
           WHERE workflow_id = ? AND organization_id = ? AND project_id = ?
             AND status IN ('awaiting_review', 'pending')`
        )
        .bind(params.workflowId, params.organizationId, params.projectId)
        .run();
    },
  };
}

async function decide(
  db: AppDb,
  params: WorkflowDecisionInput,
  from: WorkflowExecutionStatus,
  to: WorkflowExecutionStatus
): Promise<WorkflowExecutionRow | null> {
  const row = await db
    .prepare(
      `UPDATE workflow_executions
         SET status = ?, attempt_count = 0, next_attempt_at = NULL, locked_at = NULL,
             error = NULL, decided_by = ?, decided_at = sdp_iso_now(),
             updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND project_id = ? AND token_id = ?
         AND status = ?
       RETURNING *`
    )
    .bind(
      to,
      params.decidedBy,
      params.executionId,
      params.organizationId,
      params.projectId,
      params.tokenId,
      from
    )
    .first<Record<string, unknown>>();
  return row ? mapExecutionRow(row) : null;
}
