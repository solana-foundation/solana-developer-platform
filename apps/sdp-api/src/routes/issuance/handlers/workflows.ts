import {
  listActionsForAsset,
  listTriggers,
  resolveWorkflowAction,
  resolveWorkflowTrigger,
  validateActionSupported,
  WORKFLOW_RULE_VERSION,
} from "@sdp/issuance/workflows";
import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_TYPES,
  type WorkflowActionType,
  type WorkflowCondition,
  type WorkflowTriggerType,
} from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import type { AssetWorkflowDefinition, AssetWorkflowRow } from "@/db/repositories";
import {
  createAssetWorkflowsRepository,
  createWebhookEndpointsRepository,
  createWorkflowExecutionsRepository,
} from "@/db/repositories";
import { badRequest, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { storeActionSecret } from "@/services/workflows/action-secret";
import { resolveAssetGateContext } from "@/services/workflows/asset-gate";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { assertWorkflowActionPermitted } from "./workflow-authz";
import {
  actionParamsShape,
  isSecretParamKey,
  redactActionParams,
  validateActionParams,
} from "./workflow-params";

type AppContext = Context<{ Bindings: Env }>;

// Guard clauses are re-evaluated on every matching event, so the list is capped rather
// than left unbounded.
const MAX_GUARDS = 20;

const conditionSchema = z.object({
  all: z
    .array(
      z.object({
        field: z.string().min(1).max(64),
        op: z.enum(["eq", "neq", "in"]),
        value: z.union([
          z.string().max(500),
          z.number(),
          z.array(z.union([z.string().max(500), z.number()])).max(50),
        ]),
      })
    )
    .max(MAX_GUARDS),
});

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20),
  // Capped at a day: the value drives the engine's backoff, and an unbounded delay
  // parks an execution past the point anyone remembers authoring the rule.
  retryAfterMinutes: z.number().int().min(1).max(1_440),
});

// Membership in the catalog is checked by the enum itself, not a lookup on an object
// literal — `{"actionType":"constructor"}` passes a bare index check and reaches code
// that assumes a real catalog entry.
const createWorkflowSchema = z.object({
  triggerType: z.enum(WORKFLOW_TRIGGER_TYPES),
  actionType: z.enum(WORKFLOW_ACTION_TYPES),
  condition: conditionSchema.nullish(),
  actionParams: actionParamsShape.optional(),
  reviewMode: z.enum(["auto", "manual"]).optional(),
  retryPolicy: retryPolicySchema.optional(),
  enabled: z.boolean().optional(),
});

const updateWorkflowSchema = z.object({
  condition: conditionSchema.nullish(),
  actionParams: actionParamsShape.optional(),
  reviewMode: z.enum(["auto", "manual"]).optional(),
  retryPolicy: retryPolicySchema.optional(),
  enabled: z.boolean().optional(),
});

// A guard on a field the trigger never emits is silently wrong in the worst direction:
// `eq` never matches (dead rule) and `neq` always matches — which quietly deletes the
// guard from a destructive rule.
function assertGuardFieldsKnown(
  triggerType: WorkflowTriggerType,
  condition: WorkflowCondition | null | undefined
): void {
  if (!condition) {
    return;
  }
  const allowed = resolveWorkflowTrigger(triggerType)?.conditionFields ?? [];
  const unknown = condition.all
    .map((clause) => clause.field)
    .filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw badRequest(`Unknown condition field(s) for ${triggerType}: ${unknown.join(", ")}`, {
      allowed,
    });
  }
}

// Rule reads are `tokens:read`; setting a webhook secret needs write. The secret itself
// lives in the credential store, but params are still redacted defensively so a rule
// written before that (or by any other path) can't leak one. `hasSecret` tells the
// builder to show "configured" instead of an empty field.
function toWorkflowResponse(row: AssetWorkflowRow) {
  const { params, hasSecret } = redactActionParams(row.definition.action.params);
  const { actionSecret: _omitted, ...definition } = row.definition;
  return {
    ...row,
    definition: {
      ...definition,
      action: { ...row.definition.action, params },
    },
    hasSecret: hasSecret || Boolean(row.definition.actionSecret),
  };
}

// `automated` actions are reversible side effects; `sensitive` disrupts every holder and
// `requires_approval` is irreversible, so both hold for a human by default rather than
// firing unattended on the first matching event.
function defaultReviewMode(actionType: WorkflowActionType): "auto" | "manual" {
  return resolveWorkflowAction(actionType)?.execution === "automated" ? "auto" : "manual";
}

// Validate the action's params, mapping failures onto the same 400 shape as the body
// schema so the builder can render them inline per field.
function assertActionParamsValid(
  actionType: WorkflowActionType,
  params: Record<string, string | number>
): void {
  const validated = validateActionParams(actionType, params);
  if (!validated.ok) {
    throw badRequest("Invalid action parameters", { errors: validated.errors });
  }
}

// A rule that references a registry endpoint must reference one that exists in this
// org/project (soft-deleted counts as gone — the repo read excludes it). A disabled
// endpoint is allowed at save: disable/enable is a toggle, and only the executions
// that fire while it is disabled fail.
async function assertWebhookEndpointUsable(
  env: Env,
  params: Record<string, string | number>,
  orgId: string,
  projectId: string
): Promise<void> {
  const endpointId = params.endpointId;
  if (typeof endpointId !== "string" || !endpointId) {
    return;
  }
  const endpoint = await createWebhookEndpointsRepository(env).getEndpointById({
    endpointId,
    organizationId: orgId,
    projectId,
  });
  if (!endpoint) {
    throw badRequest("Unknown webhook endpoint", {
      errors: { endpointId: ["Webhook endpoint not found in this project"] },
    });
  }
}

export const createWorkflow = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const parsed = createWorkflowSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }

  // Tier gate: authoring a `seize` rule is authoring a seize (C1). Runs before any
  // lookup so an unauthorized caller learns nothing about the token.
  assertWorkflowActionPermitted(c, parsed.data.actionType);

  const actionParams = parsed.data.actionParams ?? {};
  assertActionParamsValid(parsed.data.actionType, actionParams);
  await assertWebhookEndpointUsable(c.env, actionParams, orgId, projectId);
  assertGuardFieldsKnown(
    parsed.data.triggerType,
    (parsed.data.condition ?? null) as WorkflowCondition | null
  );

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
    isMintable: gate.isMintable,
  });
  if (!support.ok) {
    throw badRequest("Action not supported for this asset", { reason: support.reason });
  }

  // The secret never reaches the stored params; it goes to the credential store and the
  // definition keeps only a reference.
  const { params: storableParams, secret } = splitOutSecret(actionParams);

  const repo = createAssetWorkflowsRepository(c.env);
  const definition: AssetWorkflowDefinition = {
    condition: (parsed.data.condition ?? null) as WorkflowCondition | null,
    action: { type: parsed.data.actionType, params: storableParams },
    retryPolicy: parsed.data.retryPolicy ?? { maxAttempts: 5, retryAfterMinutes: 5 },
  };

  const workflow = await repo.createWorkflow({
    organizationId: orgId,
    projectId,
    tokenId,
    triggerType: parsed.data.triggerType,
    actionType: parsed.data.actionType,
    definition,
    version: WORKFLOW_RULE_VERSION,
    // A tier that the engine will hold for review anyway, or that disrupts every holder
    // when it misfires, defaults to manual — the permissive default belongs only to the
    // tier whose actions are reversible side effects.
    reviewMode: parsed.data.reviewMode ?? defaultReviewMode(parsed.data.actionType),
    enabled: parsed.data.enabled,
    createdBy: auth.id,
  });

  if (!workflow) {
    throw badRequest("Failed to create workflow");
  }
  // Stored after the insert because the secret is keyed by the rule's own id.
  const stored = secret
    ? await persistActionSecret(c.env, { orgId, projectId, workflow, definition, secret })
    : workflow;

  return created(c, { workflow: toWorkflowResponse(stored) });
};

// Pull a credential param out of the storable set. Returns the params to persist and the
// raw secret (if any) for the credential store.
function splitOutSecret(params: Record<string, string | number>): {
  params: Record<string, string | number>;
  secret: string | null;
} {
  let secret: string | null = null;
  const rest: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (isSecretParamKey(key)) {
      secret = String(value);
      continue;
    }
    rest[key] = value;
  }
  return { params: rest, secret };
}

// Writes the secret to the credential store and records the reference on the rule. A
// deployment with no store configured is refused outright rather than quietly persisting
// the key in plaintext — the rest of the rule is already saved, so the operator can
// re-save without the secret or configure the store.
async function persistActionSecret(
  env: Env,
  input: {
    orgId: string;
    projectId: string;
    workflow: AssetWorkflowRow;
    definition: AssetWorkflowDefinition;
    secret: string;
  }
): Promise<AssetWorkflowRow> {
  const result = await storeActionSecret(env, {
    orgId: input.orgId,
    workflowId: input.workflow.id,
    secret: input.secret,
  });
  if (!result.ok) {
    throw badRequest(
      "Signing secrets require a configured credential secret store on this deployment"
    );
  }
  const updated = await createAssetWorkflowsRepository(env).updateWorkflow({
    workflowId: input.workflow.id,
    organizationId: input.orgId,
    projectId: input.projectId,
    definition: { ...input.definition, actionSecret: result.stored },
  });
  return updated ?? input.workflow;
}

export const listWorkflows = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);
  const workflows = await createAssetWorkflowsRepository(c.env).listWorkflowsForToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });
  return success(c, { workflows: workflows.map(toWorkflowResponse) });
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

  // Tier comes from the stored action, never the request: the body can't change
  // `action_type`, so trusting it here would let a member edit a seize rule.
  assertWorkflowActionPermitted(c, existing.action_type);

  // Only rebuild the definition when definition fields were supplied.
  const definitionSupplied =
    parsed.data.condition !== undefined ||
    parsed.data.actionParams !== undefined ||
    parsed.data.retryPolicy !== undefined;

  let params = existing.definition.action.params;
  let secret: string | null = null;
  if (parsed.data.actionParams !== undefined) {
    assertActionParamsValid(existing.action_type, parsed.data.actionParams);
    await assertWebhookEndpointUsable(c.env, parsed.data.actionParams, orgId, projectId);
    ({ params, secret } = splitOutSecret(parsed.data.actionParams));
  }
  if (parsed.data.condition !== undefined) {
    assertGuardFieldsKnown(
      existing.trigger_type,
      (parsed.data.condition ?? null) as WorkflowCondition | null
    );
  }

  // An edit that doesn't re-send the secret keeps the stored reference — reads redact
  // it, so requiring it on every save would silently erase it.
  const definition: AssetWorkflowDefinition | undefined = definitionSupplied
    ? {
        condition:
          parsed.data.condition !== undefined
            ? ((parsed.data.condition ?? null) as WorkflowCondition | null)
            : existing.definition.condition,
        action: { type: existing.action_type, params },
        retryPolicy: parsed.data.retryPolicy ?? existing.definition.retryPolicy,
        // A rule migrated onto a registry endpoint drops its inline-secret reference —
        // the endpoint's own key signs now, and keeping the stale handle would leave
        // `hasSecret` reporting a key that no longer signs anything.
        actionSecret:
          params.endpointId !== undefined ? null : (existing.definition.actionSecret ?? null),
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
  if (!workflow) {
    throw notFound("Workflow");
  }

  // Turning a rule off withdraws what it already queued: an execution held for approval
  // is a pending side effect of a rule the operator just decided they don't want.
  if (parsed.data.enabled === false && existing.enabled) {
    await createWorkflowExecutionsRepository(c.env).cancelOpenExecutionsForWorkflow({
      workflowId,
      organizationId: orgId,
      projectId,
    });
  }

  const stored =
    secret && definition
      ? await persistActionSecret(c.env, { orgId, projectId, workflow, definition, secret })
      : workflow;

  return success(c, { workflow: toWorkflowResponse(stored) });
};

// Soft delete: the rule disappears from every read path (list, dispatch, engine
// guard) but its execution history stays queryable.
export const deleteWorkflow = async (c: AppContext) => {
  const { tokenId, workflowId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const repo = createAssetWorkflowsRepository(c.env);
  const existing = await repo.getWorkflowById({ workflowId, organizationId: orgId, projectId });
  if (!existing || existing.token_id !== tokenId) {
    throw notFound("Workflow");
  }
  assertWorkflowActionPermitted(c, existing.action_type);

  await repo.deleteWorkflow({ workflowId, organizationId: orgId, projectId });
  // Anything this rule had queued or held is withdrawn with it — otherwise a held mint
  // from a deleted rule stays in the approval queue, approvable.
  const cancelled = await createWorkflowExecutionsRepository(c.env).cancelOpenExecutionsForWorkflow(
    { workflowId, organizationId: orgId, projectId }
  );
  return success(c, { deleted: true, cancelledExecutions: cancelled });
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
      isMintable: gate.isMintable,
    }),
  });
};
