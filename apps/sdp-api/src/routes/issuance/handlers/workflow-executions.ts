import type { Context } from "hono";
import { createWorkflowExecutionsRepository } from "@/db/repositories";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

// Execution log (Ticket 3): recent executions for a token, optionally one workflow.
export const listWorkflowExecutions = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const workflowId = c.req.query("workflowId") || undefined;
  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 200);
  const offset = (page - 1) * pageSize;

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

// Safe manual retry: flips a failed / awaiting_review execution back to pending; the
// cron engine picks it up. Idempotent action handlers make a re-run converge.
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

  return success(c, { execution });
};
