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

// Flat AND of simple comparisons over the event payload (operational filters only).
function evaluateCondition(
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
        return actual === clause.value;
      case "neq":
        return actual !== clause.value;
      case "in":
        return Array.isArray(clause.value) && clause.value.includes(actual as string | number);
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

  const rules = await workflowsRepo.listEnabledWorkflowsForTrigger({
    organizationId: event.organizationId,
    projectId: event.projectId,
    triggerType: event.type,
  });

  let enqueued = 0;
  for (const rule of rules) {
    // Token-scoped events only fire the matching asset's rules.
    if (event.tokenId && rule.token_id !== event.tokenId) {
      continue;
    }
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
