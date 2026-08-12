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
  createWorkflowExecutionsRepository,
  generateAssetWorkflowId,
} from "@/db/repositories";
import { badRequest, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import {
  destroyActionSecret,
  queuePendingActionSecret,
  storeActionSecret,
} from "@/services/workflows/action-secret";
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

// The engine holds `requires_approval` actions for a human regardless of the stored
// mode (event-bus forces `awaiting_review`), so accepting `auto` here would persist a
// mode the engine ignores — the rule would claim to run unattended while every
// execution quietly queues for review.
function assertReviewModeCompatible(
  actionType: WorkflowActionType,
  reviewMode: "auto" | "manual" | undefined
): void {
  if (
    reviewMode === "auto" &&
    resolveWorkflowAction(actionType)?.execution === "requires_approval"
  ) {
    throw badRequest(`Action ${actionType} always requires manual review`);
  }
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
  assertReviewModeCompatible(parsed.data.actionType, parsed.data.reviewMode);

  const actionParams = parsed.data.actionParams ?? {};
  assertActionParamsValid(parsed.data.actionType, actionParams);
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

  // Mint the id here so the credential can be written before the insert. Attaching it
  // afterwards meant a store failure answered 400 with an enabled rule already committed
  // and its plaintext secret already stripped — the caller saw a failure while a live rule
  // sent unsigned webhooks, and each retry left another row behind.
  const workflowId = generateAssetWorkflowId();
  const actionSecret = secret
    ? await storeActionSecretOrRefuse(c.env, { orgId, workflowId, secret })
    : null;
  // The credential exists in the backend and nothing references it yet, so its destruction
  // is queued NOW and cancelled by the insert below if that commits. Recording it only on
  // the failure path meant the record was lost exactly when the database was what failed.
  await queuePendingActionSecret(c.env, { orgId, workflowId, stored: actionSecret });

  const repo = createAssetWorkflowsRepository(c.env);
  const definition: AssetWorkflowDefinition = {
    condition: (parsed.data.condition ?? null) as WorkflowCondition | null,
    action: { type: parsed.data.actionType, params: storableParams },
    retryPolicy: parsed.data.retryPolicy ?? { maxAttempts: 5, retryAfterMinutes: 5 },
    actionSecret,
  };

  // Every exit from here that doesn't commit a row leaves the credential unreferenced, so
  // both of them retire it. A rejected insert is the case that actually happens: the
  // driver propagates Postgres errors, and `INSERT … RETURNING *` yields a row whenever it
  // succeeds, so the null result below is close to unreachable by comparison.
  const workflow = await repo
    .createWorkflow({
      id: workflowId,
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
      // Committing the row makes the credential referenced, which discharges the
      // obligation queued just above — in this transaction, so a rollback keeps it.
      clearRetirementFor: actionSecret,
    })
    .catch(async (error: unknown) => {
      await destroyActionSecret(c.env, actionSecret, { orgId, workflowId });
      throw error;
    });

  if (!workflow) {
    await destroyActionSecret(c.env, actionSecret, { orgId, workflowId });
    throw badRequest("Failed to create workflow");
  }

  return created(c, { workflow: toWorkflowResponse(workflow) });
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

// Writes the secret to the credential store and hands back the reference for the caller to
// fold into the definition it is about to persist. A deployment with no store configured
// is refused outright rather than quietly persisting the key in plaintext; because this
// runs before the row is written, that refusal changes nothing.
async function storeActionSecretOrRefuse(
  env: Env,
  input: { orgId: string; workflowId: string; secret: string }
): Promise<StoredCredentialSecret> {
  const result = await storeActionSecret(env, input);
  if (!result.ok) {
    throw badRequest(
      "Signing secrets require a configured credential secret store on this deployment"
    );
  }
  return result.stored;
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
  assertReviewModeCompatible(existing.action_type, parsed.data.reviewMode);

  // Only rebuild the definition when definition fields were supplied.
  const definitionSupplied =
    parsed.data.condition !== undefined ||
    parsed.data.actionParams !== undefined ||
    parsed.data.retryPolicy !== undefined;

  let params = existing.definition.action.params;
  let secret: string | null = null;
  if (parsed.data.actionParams !== undefined) {
    assertActionParamsValid(existing.action_type, parsed.data.actionParams);
    ({ params, secret } = splitOutSecret(parsed.data.actionParams));
  }
  if (parsed.data.condition !== undefined) {
    assertGuardFieldsKnown(
      existing.trigger_type,
      (parsed.data.condition ?? null) as WorkflowCondition | null
    );
  }

  // Rotation writes the new version before the row is touched, for the same reason create
  // does: attaching it afterwards meant a store failure answered 400 with the new webhook
  // URL already saved and the rule signing with the superseded key — or with nothing, when
  // the rule had no secret before this edit.
  const previousSecret = existing.definition.actionSecret ?? null;
  const actionSecret = secret
    ? await storeActionSecretOrRefuse(c.env, { orgId, workflowId, secret })
    : previousSecret;
  // As in create: the version just written has no reader until the update commits, so its
  // destruction is queued first and cancelled by that commit.
  if (secret) {
    await queuePendingActionSecret(c.env, { orgId, workflowId, stored: actionSecret });
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
        actionSecret,
      }
    : undefined;

  // As in create: a rejected write leaves the version just written unreferenced, so it is
  // retired on the way out. Only when this edit wrote one — otherwise `actionSecret` is
  // the reference the untouched row still points at.
  const workflow = await repo
    .updateWorkflow({
      workflowId,
      organizationId: orgId,
      projectId,
      definition,
      reviewMode: parsed.data.reviewMode,
      enabled: parsed.data.enabled,
      // Only the version this request wrote. What it supersedes is resolved from the row
      // under lock inside the transaction — `previousSecret` above came from a read that
      // predates it, so a concurrent rotation would make it name a version already gone.
      rotateSecretTo: secret ? actionSecret : null,
    })
    .catch(async (error: unknown) => {
      await destroyActionSecret(c.env, secret ? actionSecret : null, { orgId, workflowId });
      throw error;
    });
  if (!workflow) {
    // The rule went away between the read and the write, so no row points at the version
    // we just wrote.
    await destroyActionSecret(c.env, secret ? actionSecret : null, { orgId, workflowId });
    throw notFound("Workflow");
  }

  // The row now points at the new version, so the one it replaced has no reader left.
  // Retired here, before anything else that can throw, for the same reason: past this
  // point a failure would strand the superseded version with nothing to retire it.
  // Guarded on the refs actually differing — destroying the version the rule still points
  // at would break every subsequent delivery.
  if (
    secret &&
    previousSecret?.secretVersionRef &&
    previousSecret.secretVersionRef !== actionSecret?.secretVersionRef
  ) {
    await destroyActionSecret(c.env, previousSecret, { orgId, workflowId });
  }

  // Turning a rule off withdraws what it already queued: an execution held for approval
  // is a pending side effect of a rule the operator just decided they don't want.
  // Keyed on the request, not the enabled transition — a withdrawal that fails after
  // the row committed must be reachable by retrying the same PATCH, and on the retry
  // the rule is already disabled. A repeat on a long-disabled rule matches no rows.
  if (parsed.data.enabled === false) {
    await createWorkflowExecutionsRepository(c.env).cancelOpenExecutionsForWorkflow({
      workflowId,
      organizationId: orgId,
      projectId,
    });
  }

  return success(c, { workflow: toWorkflowResponse(workflow) });
};

// Soft delete: the rule disappears from every read path (list, dispatch, engine
// guard) but its execution history stays queryable.
export const deleteWorkflow = async (c: AppContext) => {
  const { tokenId, workflowId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const repo = createAssetWorkflowsRepository(c.env);
  // Read INCLUDING soft-deleted rows. The cleanup after the soft delete (secret
  // retirement, withdrawal of queued/held executions) can fail with the delete already
  // committed — and a retry that 404s on the now-invisible row makes that cleanup
  // permanently unreachable: the secret stays recoverable and a held execution from
  // the dead rule sits in the approval queue inviting a decision (the engine would
  // refuse it with RULE_NOT_FOUND, but nothing should ask). So delete is idempotent
  // over its own partial failure: a repeat request finishes the job.
  const existing = await repo.getWorkflowById({
    workflowId,
    organizationId: orgId,
    projectId,
    includeDeleted: true,
  });
  if (!existing || existing.token_id !== tokenId) {
    throw notFound("Workflow");
  }
  assertWorkflowActionPermitted(c, existing.action_type);

  // The rule's key is orphaned the moment the soft delete commits, so the record that it
  // still needs destroying commits with it — from the row's own value, read under lock,
  // not from `existing` above. The destroy below is then an optimisation, not the only
  // thing standing between a failure and a credential nobody retires.
  const removed = await repo.deleteWorkflow({ workflowId, organizationId: orgId, projectId });
  // The rule is gone from every read path, so its signing key has no reader left. The
  // soft delete keeps the reference on the row for history; the value itself is retired
  // rather than left recoverable from the secret backend. Retired immediately after the
  // delete commits, before anything else that can throw; replayed when this request is
  // the retry of a delete that died before reaching it (destroying an already-destroyed
  // version is a logged no-op). Skipped only when a concurrent delete owns the row —
  // it reached the soft delete first, so this cleanup is its to run.
  if (removed || existing.deleted_at !== null) {
    await destroyActionSecret(c.env, existing.definition.actionSecret, { orgId, workflowId });
  }
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
