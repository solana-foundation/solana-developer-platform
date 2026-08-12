import { resolveWorkflowAction, validateActionSupported } from "@sdp/issuance/workflows";
import { WORKFLOW_ACTION_TYPES } from "@sdp/types";
import { getDb } from "@/db";
import {
  type AssetWorkflowRow,
  type AssetWorkflowsRepository,
  createAssetWorkflowsRepository,
  createWorkflowExecutionsRepository,
  type WorkflowExecutionRow,
  type WorkflowExecutionsRepository,
} from "@/db/repositories";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import { dispatchWorkflowAction } from "@/services/workflows/actions";
import { type AssetGateContext, resolveAssetGateContext } from "@/services/workflows/asset-gate";
import type { Env } from "@/types/env";

// Engine tuning. Kept as constants (no new env vars) — safe defaults for v1.
const BATCH_SIZE = 25;
// The longest single action is a 10s webhook or a chain submit — a crashed tick
// shouldn't park work for long.
const STALE_AFTER_MS = 3 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MINUTES = 5;
const MAX_RETRY_DELAY_MINUTES = 6 * 60;
// Rows run with bounded parallelism so one webhook-heavy batch can't push the tick
// past the next cron fire (rows are independent — each is individually claimed).
const CONCURRENCY = 5;

// Approval-gated (destructive, non-idempotent) actions: never auto-re-dispatched after
// a crash — a stale row parks as failed for a human to inspect and re-approve.
const APPROVAL_GATED_ACTIONS = WORKFLOW_ACTION_TYPES.filter(
  (type) => resolveWorkflowAction(type)?.execution === "requires_approval"
);

// Outcome of the execution-time guard: either the rule's action params to dispatch
// with, or a permanent reason to fail the execution (rule gone / disabled / capability
// revoked after the event was enqueued). Never retried — these don't self-heal.
type GuardResult =
  | {
      ok: true;
      params: Record<string, string | number>;
      actionSecret: StoredCredentialSecret | null;
      retryAfterMinutes: number;
    }
  | { ok: false; error: string };

// Per-tick caches: a batch typically holds many executions of the same few rules on
// the same few tokens — load each rule and gate context once, not once per row.
interface TickCaches {
  rules: Map<string, AssetWorkflowRow | null>;
  gates: Map<string, AssetGateContext | null>;
}

// A batch spans every tenant, and both cached lookups are tenant-scoped — so the key has
// to carry the tenant as well as the id. Keyed on the id alone, an execution whose
// organization/project disagree with the owner of its workflow_id (or token_id) takes a
// cache hit and never runs the predicate the loader applies, reading another tenant's
// rule or gate. Nothing upstream makes that key collision impossible: the table's
// organization_id and workflow_id foreign keys are independent, so no constraint ties an
// execution to the owner of the rule it names.
function tenantCacheKey(execution: WorkflowExecutionRow, id: string): string {
  return `${execution.organization_id}:${execution.project_id}:${id}`;
}

async function loadRule(
  workflowsRepo: AssetWorkflowsRepository,
  caches: TickCaches,
  execution: WorkflowExecutionRow
): Promise<AssetWorkflowRow | null> {
  const key = tenantCacheKey(execution, execution.workflow_id);
  const cached = caches.rules.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const rule = await workflowsRepo.getWorkflowById({
    workflowId: execution.workflow_id,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
  });
  caches.rules.set(key, rule);
  return rule;
}

async function loadGate(
  env: Env,
  caches: TickCaches,
  execution: WorkflowExecutionRow
): Promise<AssetGateContext | null> {
  const key = tenantCacheKey(execution, execution.token_id);
  const cached = caches.gates.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const gate = await resolveAssetGateContext(env, {
    tokenId: execution.token_id,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
  });
  caches.gates.set(key, gate);
  return gate;
}

// Re-validate a claimed execution against live state before running its side effect.
// The rule may have been deleted, disabled, or had its unlocking capability turned off
// between enqueue and now — all of which must block the action with a clear reason
// rather than execute stale intent. Also the single place the rule's static action
// params (and retry pacing) are loaded and threaded to the handler.
async function guardExecution(
  env: Env,
  workflowsRepo: AssetWorkflowsRepository,
  caches: TickCaches,
  execution: WorkflowExecutionRow
): Promise<GuardResult> {
  const rule = await loadRule(workflowsRepo, caches, execution);
  if (!rule) {
    return { ok: false, error: "RULE_NOT_FOUND" };
  }
  if (!rule.enabled) {
    return { ok: false, error: "RULE_DISABLED" };
  }

  const gate = await loadGate(env, caches, execution);
  if (!gate) {
    return { ok: false, error: "ASSET_CONTEXT_UNAVAILABLE" };
  }

  const support = validateActionSupported({
    action: execution.action_type,
    category: gate.category,
    type: gate.type,
    selectedSettings: gate.selectedSettings,
    hasAllowlist: gate.hasAllowlist,
    isMintable: gate.isMintable,
  });
  if (!support.ok) {
    return { ok: false, error: `CAPABILITY_REVOKED:${support.reason}` };
  }

  return {
    ok: true,
    params: rule.definition.action.params,
    actionSecret: rule.definition.actionSecret ?? null,
    retryAfterMinutes:
      rule.definition.retryPolicy?.retryAfterMinutes ?? DEFAULT_RETRY_AFTER_MINUTES,
  };
}

// Exponential backoff with jitter, based on the rule's retryAfterMinutes: attempt n
// waits base × 2^(n-1) minutes (±20%), capped. Jitter keeps a fleet of failures from
// retrying in lockstep.
function nextAttemptIso(now: Date, baseMinutes: number, attemptCount: number): string {
  const exponent = Math.max(attemptCount - 1, 0);
  const minutes = Math.min(baseMinutes * 2 ** exponent, MAX_RETRY_DELAY_MINUTES);
  const jitter = 0.8 + Math.random() * 0.4;
  return new Date(now.getTime() + minutes * 60 * 1000 * jitter).toISOString();
}

export interface RunWorkflowExecutionsResult {
  recovered: number;
  succeeded: number;
  failed: number;
  retried: number;
}

function logExecutionFailure(row: WorkflowExecutionRow, error: unknown): void {
  getLogger().error(
    {
      error: error instanceof Error ? error.message : String(error),
      organizationId: row.organization_id,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      executionId: row.id,
      actionType: row.action_type,
    },
    "runDueWorkflowExecutions: action threw"
  );
}

type AuditTerminal = (
  row: WorkflowExecutionRow,
  status: "success" | "failure",
  extra: Record<string, unknown>
) => Promise<void>;

// Claim + guard + dispatch + record one due execution.
async function processDueExecution(deps: {
  env: Env;
  repo: WorkflowExecutionsRepository;
  workflowsRepo: AssetWorkflowsRepository;
  caches: TickCaches;
  auditTerminal: AuditTerminal;
  result: RunWorkflowExecutionsResult;
  now: Date;
  row: WorkflowExecutionRow;
}): Promise<void> {
  const { env, repo, workflowsRepo, caches, auditTerminal, result, now, row } = deps;

  // Optimistic claim (increments attempt_count); another worker may have taken it.
  const claimed = await repo.claimExecution({ executionId: row.id });
  if (!claimed) {
    return;
  }

  // Single-shot for approval-gated (destructive) actions: each run was explicitly
  // authorized by a human, so a failure must come back to a human — never re-enter
  // the automatic retry loop.
  const singleShot = resolveWorkflowAction(claimed.action_type)?.execution === "requires_approval";

  let retryAfterMinutes = DEFAULT_RETRY_AFTER_MINUTES;
  try {
    // Re-validate against live state before acting (rule may have been disabled or
    // its capability revoked since enqueue); also loads the rule's action params.
    const guard = await guardExecution(env, workflowsRepo, caches, claimed);
    if (!guard.ok) {
      await repo.failExecution({ executionId: claimed.id, error: guard.error });
      await auditTerminal(claimed, "failure", { reason: guard.error });
      result.failed += 1;
      return;
    }
    retryAfterMinutes = guard.retryAfterMinutes;

    const outcome = await dispatchWorkflowAction(env, claimed, {
      params: guard.params,
      actionSecret: guard.actionSecret,
    });
    if (outcome.status === "succeeded") {
      await repo.completeExecution({ executionId: claimed.id, result: outcome.result });
      await auditTerminal(claimed, "success", { result: outcome.result });
      result.succeeded += 1;
    } else if (singleShot || !outcome.retryable || claimed.attempt_count >= claimed.max_attempts) {
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
        nextAttemptAt: nextAttemptIso(now, retryAfterMinutes, claimed.attempt_count),
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
      await repo.rescheduleExecution({
        executionId: claimed.id,
        error: message,
        nextAttemptAt: nextAttemptIso(now, retryAfterMinutes, claimed.attempt_count),
      });
      result.retried += 1;
    }
  }
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
  // System audit writers require the external checkpoint store (fail-closed ledger).
  const audit = new AuditService(getDb(env), createKVStoreSet(env).cache);
  const result: RunWorkflowExecutionsResult = { recovered: 0, succeeded: 0, failed: 0, retried: 0 };
  const caches: TickCaches = { rules: new Map(), gates: new Map() };

  // Durable audit row for a terminal execution outcome (system actor → "SDP"). Only
  // terminal states are audited — transient reschedules would be noise. metadata.tokenId
  // surfaces the event in the per-asset audit feed. Never throws — an audit write
  // failure must not break the tick, so persistence errors are logged and swallowed.
  const auditTerminal: AuditTerminal = (row, status, extra) =>
    audit
      .logSystem({
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
      })
      .catch((error: unknown) => {
        getLogger().error(
          { error: error instanceof Error ? error.message : String(error) },
          "workflow engine: system audit write failed"
        );
      });

  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS).toISOString();

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

  // 2. Due + retryable rows, oldest first, processed by a small worker pool.
  const due = await repo.listDueExecutions({ dueBefore: nowIso, limit: BATCH_SIZE });
  const queue = [...due];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        await processDueExecution({
          env,
          repo,
          workflowsRepo,
          caches,
          auditTerminal,
          result,
          now,
          row,
        });
      }
    })
  );

  return result;
}
