import { resolveWorkflowAction } from "@sdp/issuance/workflows";
import type { WorkflowCondition, WorkflowTriggerType } from "@sdp/types";
import {
  createAssetWorkflowsRepository,
  createWorkflowExecutionsRepository,
} from "@/db/repositories";
import type { Env } from "@/types/env";

// A normalized domain event. Trigger *sources* (Mural webhook today, external API
// webhooks / native KYC later) all build one of these and hand it to the bus —
// they never touch workflow internals. The bus only enqueues durable executions;
// the cron engine runs them.
export interface WorkflowEvent {
  type: WorkflowTriggerType;
  organizationId: string;
  projectId: string;
  // Event identity for idempotency (unique per real-world occurrence).
  eventKey: string;
  // Token-scoped events (e.g. kyc_approved) constrain matching to that asset's rules.
  tokenId?: string;
  payload: Record<string, unknown>;
}

// Guard values are typed by hand in a text field while payload values come from the
// emitters, so a strict comparison silently never matches on the two mismatches that
// actually happen: a number typed as text (`attempt` 3 vs "3") and a difference in case
// (`Mural` vs `mural`). Comparing on a normalized string covers both. Both sides are
// scalars — the builder can't express object guards.
function sameValue(actual: unknown, expected: string | number): boolean {
  if (actual === expected) {
    return true;
  }
  if (actual == null) {
    return false;
  }
  return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
}

// Flat AND of simple comparisons over the event payload (operational filters only).
// Exported for tests: a guard that silently never matches produces no execution row and
// nothing to debug, so the comparison semantics are worth pinning directly.
export function evaluateCondition(
  condition: WorkflowCondition | null | undefined,
  payload: Record<string, unknown>
): boolean {
  if (!condition) {
    return true;
  }
  return condition.all.every((clause) => {
    const actual = payload[clause.field];
    switch (clause.op) {
      case "eq":
        return sameValue(actual, clause.value as string | number);
      case "neq":
        return !sameValue(actual, clause.value as string | number);
      case "in":
        return (
          Array.isArray(clause.value) && clause.value.some((option) => sameValue(actual, option))
        );
      default:
        return false;
    }
  });
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Match enabled rules for (project, trigger type), evaluate each guard, and insert a
 * durable workflow_executions row per match. Idempotent via the (workflow_id,
 * idempotency_key) unique index, so re-delivered events are no-ops. Returns the count
 * of executions enqueued. Does NOT run actions — that's the cron engine's job.
 */
export async function dispatchWorkflowEvent(env: Env, event: WorkflowEvent): Promise<number> {
  const workflowsRepo = createAssetWorkflowsRepository(env);
  const executionsRepo = createWorkflowExecutionsRepository(env);

  // Token-scoped events only fire the matching asset's rules (filtered in SQL).
  const rules = await workflowsRepo.listEnabledWorkflowsForTrigger({
    organizationId: event.organizationId,
    projectId: event.projectId,
    triggerType: event.type,
    tokenId: event.tokenId,
  });

  let enqueued = 0;
  for (const rule of rules) {
    if (!evaluateCondition(rule.definition.condition, event.payload)) {
      continue;
    }

    // Manual review mode OR an irreversible action → hold for a human.
    const action = resolveWorkflowAction(rule.action_type);
    const requiresApproval = action?.execution === "requires_approval";
    const status =
      rule.review_mode === "manual" || requiresApproval ? "awaiting_review" : "pending";

    const created = await executionsRepo.createExecution({
      organizationId: event.organizationId,
      projectId: event.projectId,
      workflowId: rule.id,
      tokenId: rule.token_id,
      triggerType: rule.trigger_type,
      actionType: rule.action_type,
      status,
      idempotencyKey: event.eventKey,
      triggerPayload: event.payload,
      maxAttempts: rule.definition.retryPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    if (created) {
      enqueued += 1;
    }
  }

  return enqueued;
}
