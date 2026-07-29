import { resolveWorkflowAction, validateActionSupported } from "@sdp/issuance/workflows";
import { WORKFLOW_ACTION_TYPES } from "@sdp/types";
import { getDb } from "@/db";
import {
  type AssetWorkflowsRepository,
  createAssetWorkflowsRepository,
  createWorkflowExecutionsRepository,
  type WorkflowExecutionRow,
} from "@/db/repositories";
import { AuditService } from "@/services/audit.service";
import { dispatchWorkflowAction } from "@/services/workflows/actions";
import { resolveAssetGateContext } from "@/services/workflows/asset-gate";
import type { Env } from "@/types/env";

// Engine tuning. Kept as constants (no new env vars) — safe defaults for v1.
const BATCH_SIZE = 25;
const STALE_AFTER_MS = 15 * 60 * 1000;
const RETRY_AFTER_MINUTES = 5;

// Approval-gated (destructive, non-idempotent) actions: never auto-re-dispatched after
// a crash — a stale row parks as failed for a human to inspect and re-approve.
const APPROVAL_GATED_ACTIONS = WORKFLOW_ACTION_TYPES.filter(
  (type) => resolveWorkflowAction(type)?.execution === "requires_approval"
);

// Outcome of the execution-time guard: either the rule's action params to dispatch
// with, or a permanent reason to fail the execution (rule gone / disabled / capability
// revoked after the event was enqueued). Never retried — these don't self-heal.
type GuardResult =
  | { ok: true; params: Record<string, string | number> }
  | { ok: false; error: string };

// Re-validate a claimed execution against live state before running its side effect.
// The rule may have been deleted, disabled, or had its unlocking capability turned off
// between enqueue and now — all of which must block the action with a clear reason
// rather than execute stale intent. Also the single place the rule's static action
// params are loaded and threaded to the handler.
async function guardExecution(
  env: Env,
  workflowsRepo: AssetWorkflowsRepository,
  execution: WorkflowExecutionRow
): Promise<GuardResult> {
  const rule = await workflowsRepo.getWorkflowById({
    workflowId: execution.workflow_id,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
  });
  if (!rule) {
    return { ok: false, error: "RULE_NOT_FOUND" };
  }
  if (!rule.enabled) {
    return { ok: false, error: "RULE_DISABLED" };
  }

  const gate = await resolveAssetGateContext(env, {
    tokenId: execution.token_id,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
  });
  if (!gate) {
    return { ok: false, error: "ASSET_CONTEXT_UNAVAILABLE" };
  }

  const support = validateActionSupported({
    action: execution.action_type,
    category: gate.category,
    type: gate.type,
    selectedSettings: gate.selectedSettings,
    hasAllowlist: gate.hasAllowlist,
  });
  if (!support.ok) {
    return { ok: false, error: `CAPABILITY_REVOKED:${support.reason}` };
  }

  return { ok: true, params: rule.definition.action.params };
}

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
  const workflowsRepo = createAssetWorkflowsRepository(env);
  const audit = new AuditService(getDb(env));
  const result: RunWorkflowExecutionsResult = { recovered: 0, succeeded: 0, failed: 0, retried: 0 };

  // Durable audit row for a terminal execution outcome (system actor → "SDP"). Only
  // terminal states are audited — transient reschedules would be noise. metadata.tokenId
  // surfaces the event in the per-asset audit feed. Never throws (logSystem swallows).
  const auditTerminal = (
    row: WorkflowExecutionRow,
    status: "success" | "failure",
    extra: Record<string, unknown>
  ) =>
    audit.logSystem({
      organizationId: row.organization_id,
      action: status === "success" ? "workflow_action_executed" : "workflow_action_failed",
      resourceType: "workflow_execution",
      resourceId: row.id,
      status,
      metadata: {
        tokenId: row.token_id,
        workflowId: row.workflow_id,
        triggerType: row.trigger_type,
        actionType: row.action_type,
        ...extra,
      },
    });

  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  const nextAttemptAt = new Date(now.getTime() + RETRY_AFTER_MINUTES * 60 * 1000).toISOString();

  // 1. A prior tick died mid-flight → reset stale 'processing' rows to 'pending';
  // approval-gated rows park as failed (their side effect may already have landed).
  const stale = await repo.recoverStaleProcessing({
    staleBefore,
    limit: BATCH_SIZE,
    parkActionTypes: APPROVAL_GATED_ACTIONS,
  });
  result.recovered = stale.recovered;
  for (const parked of stale.parked) {
    await auditTerminal(parked, "failure", { reason: "STALE_RECOVERED_NEEDS_REVIEW" });
    result.failed += 1;
  }

  // 2. Due + retryable rows, oldest first.
  const due = await repo.listDueExecutions({ dueBefore: nowIso, limit: BATCH_SIZE });

  for (const row of due) {
    // 3. Optimistic claim (increments attempt_count); another worker may have taken it.
    const claimed = await repo.claimExecution({ executionId: row.id });
    if (!claimed) {
      continue;
    }

    // Single-shot for approval-gated (destructive) actions: each run was explicitly
    // authorized by a human, so a failure must come back to a human — never re-enter
    // the automatic retry loop.
    const singleShot =
      resolveWorkflowAction(claimed.action_type)?.execution === "requires_approval";

    try {
      // Re-validate against live state before acting (rule may have been disabled or
      // its capability revoked since enqueue); also loads the rule's action params.
      const guard = await guardExecution(env, workflowsRepo, claimed);
      if (!guard.ok) {
        await repo.failExecution({ executionId: claimed.id, error: guard.error });
        await auditTerminal(claimed, "failure", { reason: guard.error });
        result.failed += 1;
        continue;
      }

      const outcome = await dispatchWorkflowAction(env, claimed, { params: guard.params });
      if (outcome.status === "succeeded") {
        await repo.completeExecution({ executionId: claimed.id, result: outcome.result });
        await auditTerminal(claimed, "success", { result: outcome.result });
        result.succeeded += 1;
      } else if (
        singleShot ||
        !outcome.retryable ||
        claimed.attempt_count >= claimed.max_attempts
      ) {
        await repo.failExecution({
          executionId: claimed.id,
          error: outcome.error ?? "action failed",
          result: outcome.result,
        });
        await auditTerminal(claimed, "failure", { reason: outcome.error ?? "action failed" });
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
      if (singleShot || claimed.attempt_count >= claimed.max_attempts) {
        await repo.failExecution({ executionId: claimed.id, error: message });
        await auditTerminal(claimed, "failure", { reason: message });
        result.failed += 1;
      } else {
        await repo.rescheduleExecution({ executionId: claimed.id, error: message, nextAttemptAt });
        result.retried += 1;
      }
    }
  }

  return result;
}
