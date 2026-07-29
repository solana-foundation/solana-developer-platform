import {
  listActionsForAsset,
  listTriggers,
  resolveWorkflowAction,
  resolveWorkflowTrigger,
  validateActionSupported,
  WORKFLOW_RULE_VERSION,
} from "@sdp/issuance/workflows";
import type { WorkflowActionType, WorkflowCondition, WorkflowTriggerType } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import type { AssetWorkflowDefinition } from "@/db/repositories";
import { createAssetWorkflowsRepository } from "@/db/repositories";
import { badRequest, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { resolveAssetGateContext } from "@/services/workflows/asset-gate";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

const conditionSchema = z.object({
  all: z.array(
    z.object({
      field: z.string(),
      op: z.enum(["eq", "neq", "in"]),
      value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
    })
  ),
});

const createWorkflowSchema = z.object({
  triggerType: z.string(),
  actionType: z.string(),
  condition: conditionSchema.nullish(),
  actionParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  reviewMode: z.enum(["auto", "manual"]).optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(20),
      retryAfterMinutes: z.number().int().min(1),
    })
    .optional(),
  enabled: z.boolean().optional(),
});

const updateWorkflowSchema = z.object({
  condition: conditionSchema.nullish(),
  actionParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  reviewMode: z.enum(["auto", "manual"]).optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(20),
      retryAfterMinutes: z.number().int().min(1),
    })
    .optional(),
  enabled: z.boolean().optional(),
});

export const createWorkflow = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const parsed = createWorkflowSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }

  if (!resolveWorkflowTrigger(parsed.data.triggerType)) {
    throw badRequest(`Unknown trigger type: ${parsed.data.triggerType}`);
  }
  if (!resolveWorkflowAction(parsed.data.actionType)) {
    throw badRequest(`Unknown action type: ${parsed.data.actionType}`);
  }

  const gate = await resolveAssetGateContext(c.env, {
    tokenId,
    organizationId: orgId,
    projectId,
  });
  if (!gate) {
    throw notFound("Token");
  }

  // Save-time capability gate (Ticket 5): reject a rule the asset can't perform.
  const support = validateActionSupported({
    action: parsed.data.actionType as WorkflowActionType,
    category: gate.category,
    type: gate.type,
    selectedSettings: gate.selectedSettings,
    hasAllowlist: gate.hasAllowlist,
  });
  if (!support.ok) {
    throw badRequest("Action not supported for this asset", { reason: support.reason });
  }

  const definition: AssetWorkflowDefinition = {
    condition: (parsed.data.condition ?? null) as WorkflowCondition | null,
    action: {
      type: parsed.data.actionType as WorkflowActionType,
      params: parsed.data.actionParams ?? {},
    },
    retryPolicy: parsed.data.retryPolicy ?? { maxAttempts: 5, retryAfterMinutes: 5 },
  };

  const workflow = await createAssetWorkflowsRepository(c.env).createWorkflow({
    organizationId: orgId,
    projectId,
    tokenId,
    triggerType: parsed.data.triggerType as WorkflowTriggerType,
    actionType: parsed.data.actionType as WorkflowActionType,
    definition,
    version: WORKFLOW_RULE_VERSION,
    reviewMode: parsed.data.reviewMode ?? "auto",
    enabled: parsed.data.enabled,
    createdBy: auth.id,
  });

  return created(c, { workflow });
};

export const listWorkflows = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);
  const workflows = await createAssetWorkflowsRepository(c.env).listWorkflowsForToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });
  return success(c, { workflows });
};

export const updateWorkflow = async (c: AppContext) => {
  const { tokenId, workflowId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const parsed = updateWorkflowSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }

  const repo = createAssetWorkflowsRepository(c.env);
  const existing = await repo.getWorkflowById({ workflowId, organizationId: orgId, projectId });
  if (!existing || existing.token_id !== tokenId) {
    throw notFound("Workflow");
  }

  // Only rebuild the definition when definition fields were supplied.
  const definitionSupplied =
    parsed.data.condition !== undefined ||
    parsed.data.actionParams !== undefined ||
    parsed.data.retryPolicy !== undefined;
  const definition: AssetWorkflowDefinition | undefined = definitionSupplied
    ? {
        condition:
          parsed.data.condition !== undefined
            ? ((parsed.data.condition ?? null) as WorkflowCondition | null)
            : existing.definition.condition,
        action: {
          type: existing.action_type,
          params: parsed.data.actionParams ?? existing.definition.action.params,
        },
        retryPolicy: parsed.data.retryPolicy ?? existing.definition.retryPolicy,
      }
    : undefined;

  const workflow = await repo.updateWorkflow({
    workflowId,
    organizationId: orgId,
    projectId,
    definition,
    reviewMode: parsed.data.reviewMode,
    enabled: parsed.data.enabled,
  });

  return success(c, { workflow });
};

// Catalog for the builder UI: which triggers exist and which actions this asset
// supports (with a support verdict) — analogous to listSettingsForType.
export const listWorkflowCatalog = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const gate = await resolveAssetGateContext(c.env, {
    tokenId,
    organizationId: orgId,
    projectId,
  });
  if (!gate) {
    throw notFound("Token");
  }

  return success(c, {
    triggers: listTriggers(),
    actions: listActionsForAsset({
      category: gate.category,
      type: gate.type,
      selectedSettings: gate.selectedSettings,
      hasAllowlist: gate.hasAllowlist,
    }),
  });
};
