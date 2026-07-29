import type { Context } from "hono";
import { getDb } from "@/db";
import { createWorkflowExecutionsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

// Execution log (Ticket 3): recent executions for a token, optionally one workflow.
export const listWorkflowExecutions = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const workflowId = c.req.query("workflowId") || undefined;
  const { page, pageSize, offset } = parsePagination(
    { page: c.req.query("page"), pageSize: c.req.query("pageSize") },
    { pageSize: 50, maxPageSize: 200 }
  );

  const { rows, total } = await createWorkflowExecutionsRepository(c.env).listExecutions({
    organizationId: orgId,
    projectId,
    tokenId,
    workflowId,
    limit: pageSize,
    offset,
  });

  return success(c, { executions: rows, total, page, pageSize });
};

// A human decision on a held/failed execution is audit-worthy in its own right: the
// engine's terminal audit rows carry the "SDP" system actor, so without this there is
// no record of WHO approved a destructive action or declined it.
async function auditDecision(
  c: AppContext,
  decision: "workflow_execution_approved" | "workflow_execution_rejected",
  execution: WorkflowExecutionRow
): Promise<void> {
  await new AuditService(getDb(c.env)).log(c, {
    action: decision,
    resourceType: "workflow_execution",
    resourceId: execution.id,
    metadata: {
      tokenId: execution.token_id,
      workflowId: execution.workflow_id,
      triggerType: execution.trigger_type,
      actionType: execution.action_type,
    },
  });
}

// Safe manual retry / approve: flips a failed / awaiting_review execution back to
// pending; the cron engine picks it up. Idempotent action handlers make a re-run converge.
export const retryWorkflowExecution = async (c: AppContext) => {
  const { executionId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const execution = await createWorkflowExecutionsRepository(c.env).retryExecution({
    executionId,
    organizationId: orgId,
    projectId,
  });
  if (!execution) {
    // Not found, or not in a retryable state.
    throw notFound("Retryable execution");
  }

  await auditDecision(c, "workflow_execution_approved", execution);
  return success(c, { execution });
};

// Reject a held execution: awaiting_review → cancelled. The action never runs.
export const cancelWorkflowExecution = async (c: AppContext) => {
  const { executionId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const execution = await createWorkflowExecutionsRepository(c.env).cancelExecution({
    executionId,
    organizationId: orgId,
    projectId,
  });
  if (!execution) {
    // Not found, or not awaiting review.
    throw notFound("Execution awaiting review");
  }

  await auditDecision(c, "workflow_execution_rejected", execution);
  return success(c, { execution });
};
