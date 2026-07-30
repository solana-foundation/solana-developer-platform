import type { Context } from "hono";
import { getDb } from "@/db";
import { createWorkflowExecutionsRepository, type WorkflowExecutionRow } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { assertWorkflowActionPermitted } from "./workflow-authz";

type AppContext = Context<{ Bindings: Env }>;

// Payload/result keys the execution log is allowed to return.
//
// Two reasons for an allowlist rather than the raw JSONB. Approving a held mint or seize
// without seeing its target wallet and amount is approving blind, so these fields have
// to reach the UI. But returning the whole blob also ships every key an emitter ever
// adds — none of it documented in the OpenAPI schema — to any `tokens:read` caller.
const PAYLOAD_FIELDS = [
  "wallet",
  "source",
  "destination",
  "amount",
  "operation",
  "provider",
  "counterpartyKind",
  "fiatCurrency",
  "cryptoToken",
  "attempt",
] as const;

const RESULT_FIELDS = [
  "signature",
  "status",
  "notified",
  "emailed",
  "alreadyFrozen",
  "alreadyThawed",
  "mirrorFailed",
] as const;

function project(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      projected[field] = source[field];
    }
  }
  return projected;
}

function toExecutionResponse(row: WorkflowExecutionRow) {
  return {
    ...row,
    trigger_payload: project(row.trigger_payload, PAYLOAD_FIELDS),
    result: project(row.result, RESULT_FIELDS),
  };
}

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

  return success(c, { executions: rows.map(toExecutionResponse), total, page, pageSize });
};

type Decision =
  | "workflow_execution_approved"
  | "workflow_execution_rejected"
  | "workflow_execution_retried";

// A human decision on a held/failed execution is audit-worthy in its own right: the
// engine's terminal audit rows carry the "SDP" system actor, so without this there is
// no record of WHO approved a destructive action or declined it.
async function auditDecision(
  c: AppContext,
  decision: Decision,
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

// Shared preamble for the three decision routes. The tier gate reads the STORED action
// type: approving a held mint is authorizing a mint, so it must clear the same bar as
// POST /tokens/:id/mint rather than the bar for "click a button in a list".
async function loadDecidableExecution(c: AppContext): Promise<{
  execution: WorkflowExecutionRow;
  decidedBy: string;
}> {
  const { executionId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const execution = await createWorkflowExecutionsRepository(c.env).getExecutionById({
    executionId,
    organizationId: orgId,
    projectId,
  });
  if (!execution || execution.token_id !== c.req.param("tokenId")) {
    throw notFound("Execution");
  }
  assertWorkflowActionPermitted(c, execution.action_type);
  return { execution, decidedBy: auth.id };
}

// Approve a held execution: awaiting_review → pending, and the engine runs it once.
export const approveWorkflowExecution = async (c: AppContext) => {
  const { execution: held, decidedBy } = await loadDecidableExecution(c);

  const execution = await createWorkflowExecutionsRepository(c.env).approveExecution({
    executionId: held.id,
    organizationId: held.organization_id,
    projectId: held.project_id,
    tokenId: held.token_id,
    decidedBy,
  });
  if (!execution) {
    throw notFound("Execution awaiting review");
  }

  await auditDecision(c, "workflow_execution_approved", execution);
  return success(c, { execution: toExecutionResponse(execution) });
};

// Retry a failed execution: failed → pending. Distinct from approve — this one already
// ran, so the audit trail should not claim someone authorized it for the first time.
export const retryWorkflowExecution = async (c: AppContext) => {
  const { execution: failed, decidedBy } = await loadDecidableExecution(c);

  const execution = await createWorkflowExecutionsRepository(c.env).retryExecution({
    executionId: failed.id,
    organizationId: failed.organization_id,
    projectId: failed.project_id,
    tokenId: failed.token_id,
    decidedBy,
  });
  if (!execution) {
    throw notFound("Retryable execution");
  }

  await auditDecision(c, "workflow_execution_retried", execution);
  return success(c, { execution: toExecutionResponse(execution) });
};

// Reject a held execution: awaiting_review → cancelled. The action never runs.
export const cancelWorkflowExecution = async (c: AppContext) => {
  const { execution: held, decidedBy } = await loadDecidableExecution(c);

  const execution = await createWorkflowExecutionsRepository(c.env).cancelExecution({
    executionId: held.id,
    organizationId: held.organization_id,
    projectId: held.project_id,
    tokenId: held.token_id,
    decidedBy,
  });
  if (!execution) {
    throw notFound("Execution awaiting review");
  }

  await auditDecision(c, "workflow_execution_rejected", execution);
  return success(c, { execution: toExecutionResponse(execution) });
};
