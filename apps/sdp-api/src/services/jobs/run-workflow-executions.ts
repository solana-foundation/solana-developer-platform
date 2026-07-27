import { createWorkflowExecutionsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { dispatchWorkflowAction } from "@/services/workflows/actions";
import type { Env } from "@/types/env";

// Engine tuning. Kept as constants (no new env vars) — safe defaults for v1.
const BATCH_SIZE = 25;
const STALE_AFTER_MS = 15 * 60 * 1000;
const RETRY_AFTER_MINUTES = 5;

export interface RunWorkflowExecutionsResult {
  recovered: number;
  succeeded: number;
  failed: number;
  retried: number;
}

function logExecutionFailure(row: WorkflowExecutionRow, error: unknown): void {
  console.error("runDueWorkflowExecutions: action threw", {
    error: error instanceof Error ? error.message : String(error),
    organizationId: row.organization_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    executionId: row.id,
    actionType: row.action_type,
  });
}

/**
 * Drain due workflow executions: recover stale-locked rows, then claim + run each
 * due execution, recording success / permanent failure / backoff-retry. Mirrors the
 * recurring-payments collection job (guarded claim, stale-lock recovery, backoff).
 */
export async function runDueWorkflowExecutions(
  env: Env,
  now = new Date()
): Promise<RunWorkflowExecutionsResult> {
  const repo = createWorkflowExecutionsRepository(env);
  const result: RunWorkflowExecutionsResult = { recovered: 0, succeeded: 0, failed: 0, retried: 0 };

  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const nextAttemptAt = new Date(now.getTime() + RETRY_AFTER_MINUTES * 60 * 1000).toISOString();

  // 1. A prior tick died mid-flight → reset stale 'processing' rows to 'pending'.
  result.recovered = await repo.recoverStaleProcessing({ staleBefore, limit: BATCH_SIZE });

  // 2. Due + retryable rows, oldest first.
  const due = await repo.listDueExecutions({ dueBefore: nowIso, limit: BATCH_SIZE });

  for (const row of due) {
    // 3. Optimistic claim (increments attempt_count); another worker may have taken it.
    const claimed = await repo.claimExecution({ executionId: row.id });
    if (!claimed) {
      continue;
    }

    try {
      const outcome = await dispatchWorkflowAction(env, claimed);
      if (outcome.status === "succeeded") {
        await repo.completeExecution({ executionId: claimed.id, result: outcome.result });
        result.succeeded += 1;
      } else if (!outcome.retryable || claimed.attempt_count >= claimed.max_attempts) {
        await repo.failExecution({
          executionId: claimed.id,
          error: outcome.error ?? "action failed",
          result: outcome.result,
        });
        result.failed += 1;
      } else {
        await repo.rescheduleExecution({
          executionId: claimed.id,
          error: outcome.error ?? "action failed",
          nextAttemptAt,
        });
        result.retried += 1;
      }
    } catch (error) {
      logExecutionFailure(claimed, error);
      const message = error instanceof Error ? error.message : String(error);
      if (claimed.attempt_count >= claimed.max_attempts) {
        await repo.failExecution({ executionId: claimed.id, error: message });
        result.failed += 1;
      } else {
        await repo.rescheduleExecution({ executionId: claimed.id, error: message, nextAttemptAt });
        result.retried += 1;
      }
    }
  }

  return result;
}
