import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import type { WebhookDeliveryRow, WebhookEndpointRow } from "@/db/repositories";
import {
  createAssetWorkflowsRepository,
  createWebhookDeliveriesRepository,
  createWebhookEndpointsRepository,
  generateWebhookDeliveryId,
  generateWebhookEndpointId,
} from "@/db/repositories";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { created, paginated, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  destroyEndpointSecretVersion,
  generateWebhookSecret,
  resolveLiveEndpointSecrets,
  storeEndpointSecret,
} from "@/services/workflows/endpoint-secret";
import {
  sendWebhook,
  signV2,
  type WebhookSendOutcome,
} from "@/services/workflows/webhook-delivery";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../issuance/helpers";
import { createEndpointSchema, rotateSecretSchema, updateEndpointSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

const DEFAULT_ROTATION_GRACE_HOURS = 24;
const STORE_UNAVAILABLE_MESSAGE =
  "Webhook endpoint secrets require a configured credential secret store on this deployment";

// Secret handles are never serialized; the only secret-adjacent fields a read path
// exposes are the version counter and the rotation grace expiry.
function toEndpointResponse(row: WebhookEndpointRow) {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    description: row.description,
    status: row.status,
    secretVersion: row.secret_version,
    previousSecretExpiresAt: row.previous_secret_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeliveryResponse(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    triggerType: row.trigger_type,
    attempt: row.attempt,
    manual: row.manual,
    redeliveryOf: row.redelivery_of,
    requestBody: row.request_body,
    requestBodyTruncated: row.request_body_truncated,
    status: row.status,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

// Rotate legitimately takes an empty body; `c.req.json()` would throw on it.
async function readJsonBody(c: AppContext): Promise<unknown> {
  const text = await c.req.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

export const createWebhookEndpoint = async (c: AppContext) => {
  const { auth, projectId, orgId } = requireProjectScope(c);
  const parsed = createEndpointSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }

  // The secret is written to the store keyed by the endpoint's own id, so the id is
  // minted before the row exists (secret_storage is NOT NULL).
  const endpointId = generateWebhookEndpointId();
  const secret = generateWebhookSecret();
  const stored = await storeEndpointSecret(c.env, { orgId, endpointId, secret });
  if (!stored.ok) {
    throw badRequest(STORE_UNAVAILABLE_MESSAGE);
  }

  const endpoint = await createWebhookEndpointsRepository(c.env).createEndpoint({
    id: endpointId,
    organizationId: orgId,
    projectId,
    url: parsed.data.url,
    label: parsed.data.label,
    description: parsed.data.description ?? null,
    secretStorage: stored.stored,
    createdBy: auth.id,
  });
  if (!endpoint) {
    throw internalError("Failed to create webhook endpoint");
  }

  await new AuditService(getDb(c.env)).log(c, {
    action: "create",
    resourceType: "webhook_endpoint",
    resourceId: endpoint.id,
    metadata: { label: endpoint.label, url: endpoint.url },
  });

  // The plaintext is returned exactly once; there is no read path afterwards.
  return created(c, { endpoint: toEndpointResponse(endpoint), secret });
};

export const listWebhookEndpoints = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { page, pageSize, offset } = parsePagination(
    { page: c.req.query("page"), pageSize: c.req.query("pageSize") },
    { pageSize: 20, maxPageSize: 100 }
  );
  const { rows, total } = await createWebhookEndpointsRepository(c.env).listEndpoints({
    organizationId: orgId,
    projectId,
    limit: pageSize,
    offset,
  });
  return paginated(c, rows.map(toEndpointResponse), { total, page, pageSize });
};

export const getWebhookEndpoint = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId } = c.req.param();
  const endpoint = await createWebhookEndpointsRepository(c.env).getEndpointById({
    endpointId,
    organizationId: orgId,
    projectId,
  });
  if (!endpoint) {
    throw notFound("Webhook endpoint");
  }
  return success(c, { endpoint: toEndpointResponse(endpoint) });
};

export const updateWebhookEndpoint = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId } = c.req.param();
  const parsed = updateEndpointSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }
  if (
    parsed.data.label === undefined &&
    parsed.data.description === undefined &&
    parsed.data.status === undefined
  ) {
    throw badRequest("No fields to update");
  }

  const endpoint = await createWebhookEndpointsRepository(c.env).updateEndpoint({
    endpointId,
    organizationId: orgId,
    projectId,
    label: parsed.data.label,
    description: parsed.data.description,
    status: parsed.data.status,
  });
  if (!endpoint) {
    throw notFound("Webhook endpoint");
  }

  await new AuditService(getDb(c.env)).log(c, {
    action: "update",
    resourceType: "webhook_endpoint",
    resourceId: endpoint.id,
    metadata: { changed: Object.keys(parsed.data) },
  });

  return success(c, { endpoint: toEndpointResponse(endpoint) });
};

// Soft delete: the endpoint disappears from list/get and future sends permanent-fail,
// but its delivery log stays queryable. Rules referencing it are left in place (the
// response carries a count so callers can warn); their next firing records
// ENDPOINT_DELETED rather than silently vanishing.
export const deleteWebhookEndpoint = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId } = c.req.param();

  const deleted = await createWebhookEndpointsRepository(c.env).softDeleteEndpoint({
    endpointId,
    organizationId: orgId,
    projectId,
  });
  if (!deleted) {
    throw notFound("Webhook endpoint");
  }

  const referencingWorkflows = await createAssetWorkflowsRepository(
    c.env
  ).countEnabledWorkflowsReferencingEndpoint({
    endpointId,
    organizationId: orgId,
    projectId,
  });

  await new AuditService(getDb(c.env)).log(c, {
    action: "delete",
    resourceType: "webhook_endpoint",
    resourceId: endpointId,
    metadata: { referencingWorkflows },
  });

  return success(c, { deleted: true, referencingWorkflows });
};

// Rotation in place: the endpoint id stays stable (rules reference it), the displaced
// current key keeps signing until the grace expiry, and deliveries carry one signature
// per live key so receivers migrate without a dropped delivery.
export const rotateWebhookEndpointSecret = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId } = c.req.param();
  const parsed = rotateSecretSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.flattenError(parsed.error).fieldErrors });
  }
  const gracePeriodHours = parsed.data.gracePeriodHours ?? DEFAULT_ROTATION_GRACE_HOURS;

  const repo = createWebhookEndpointsRepository(c.env);
  const existing = await repo.getEndpointById({ endpointId, organizationId: orgId, projectId });
  if (!existing) {
    throw notFound("Webhook endpoint");
  }

  const secret = generateWebhookSecret();
  // `existingSecretRef` makes GCP SM store the new value as a version of the endpoint's
  // existing secret rather than minting a new one per rotation.
  const stored = await storeEndpointSecret(c.env, {
    orgId,
    endpointId,
    secret,
    existingSecretRef: existing.secret_storage.secretRef,
  });
  if (!stored.ok) {
    throw badRequest(STORE_UNAVAILABLE_MESSAGE);
  }

  // Whatever occupied the previous slot is displaced for good by this rotation.
  await destroyEndpointSecretVersion(c.env, existing.previous_secret_storage);

  const graceMs = gracePeriodHours * 3_600_000;
  const endpoint = await repo.rotateSecret({
    endpointId,
    organizationId: orgId,
    projectId,
    secretStorage: stored.stored,
    previousSecretStorage: graceMs > 0 ? existing.secret_storage : null,
    previousSecretExpiresAt: graceMs > 0 ? new Date(Date.now() + graceMs).toISOString() : null,
  });
  if (!endpoint) {
    throw notFound("Webhook endpoint");
  }
  if (graceMs <= 0) {
    // No grace: the old current key dies immediately.
    await destroyEndpointSecretVersion(c.env, existing.secret_storage);
  }

  await new AuditService(getDb(c.env)).log(c, {
    action: "rotate",
    resourceType: "webhook_endpoint",
    resourceId: endpoint.id,
    metadata: { gracePeriodHours, secretVersion: endpoint.secret_version },
  });

  // The plaintext is returned exactly once, same as create.
  return success(c, {
    endpoint: toEndpointResponse(endpoint),
    secret,
    previousSecretExpiresAt: endpoint.previous_secret_expires_at,
  });
};

export const listWebhookDeliveries = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId } = c.req.param();
  // includeDeleted: the delivery log is the point of soft delete — history stays
  // readable after the endpoint itself is gone.
  const endpoint = await createWebhookEndpointsRepository(c.env).getEndpointById({
    endpointId,
    organizationId: orgId,
    projectId,
    includeDeleted: true,
  });
  if (!endpoint) {
    throw notFound("Webhook endpoint");
  }
  const { page, pageSize, offset } = parsePagination(
    { page: c.req.query("page"), pageSize: c.req.query("pageSize") },
    { pageSize: 50, maxPageSize: 200 }
  );
  const { rows, total } = await createWebhookDeliveriesRepository(c.env).listDeliveries({
    organizationId: orgId,
    projectId,
    endpointId,
    limit: pageSize,
    offset,
  });
  return paginated(c, rows.map(toDeliveryResponse), { total, page, pageSize });
};

function outcomeToDeliveryFields(outcome: WebhookSendOutcome): {
  status: "succeeded" | "failed";
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
} {
  if (!outcome.ok) {
    return {
      status: "failed",
      responseStatus: null,
      responseBody: null,
      error: outcome.kind === "blocked" ? outcome.reason : outcome.error,
      durationMs: outcome.kind === "network" ? outcome.durationMs : null,
    };
  }
  const delivered = outcome.status >= 200 && outcome.status < 300;
  return {
    status: delivered ? "succeeded" : "failed",
    responseStatus: outcome.status,
    responseBody: outcome.responseBody || null,
    error: delivered ? null : `HTTP_${outcome.status}`,
    durationMs: outcome.durationMs,
  };
}

// Manual re-send of a logged delivery: the original request body is re-sent
// byte-identically with a fresh delivery id, timestamp and signatures, and the result
// becomes a new delivery row. Never touches workflow_executions — this is a debugging
// tool, not a retry. Synchronous: it is an interactive call and the send timeout is
// bounded; the response is 200 whatever the receiver returned (the row carries it).
export const redeliverWebhookDelivery = async (c: AppContext) => {
  const { projectId, orgId } = requireProjectScope(c);
  const { endpointId, deliveryId } = c.req.param();

  const endpoint = await createWebhookEndpointsRepository(c.env).getEndpointById({
    endpointId,
    organizationId: orgId,
    projectId,
    includeDeleted: true,
  });
  if (!endpoint) {
    throw notFound("Webhook endpoint");
  }
  if (endpoint.deleted_at) {
    throw conflict("Webhook endpoint has been deleted");
  }
  if (endpoint.status !== "active") {
    throw conflict("Webhook endpoint is disabled");
  }

  const deliveries = createWebhookDeliveriesRepository(c.env);
  const original = await deliveries.getDeliveryById({
    deliveryId,
    endpointId,
    organizationId: orgId,
    projectId,
  });
  if (!original) {
    throw notFound("Webhook delivery");
  }
  if (original.request_body_truncated) {
    // The stored body isn't the byte-exact signed payload anymore.
    throw conflict("Original request body was truncated and cannot be redelivered");
  }

  const secrets = await resolveLiveEndpointSecrets(c.env, orgId, endpoint);
  if (!secrets) {
    throw internalError("Webhook endpoint signing secret is unavailable");
  }

  const newDeliveryId = generateWebhookDeliveryId();
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const outcome = await sendWebhook({
    url: endpoint.url,
    body: original.request_body,
    headers: {
      "content-type": "application/json",
      "user-agent": "SDP-Workflows/1",
      "x-sdp-delivery": newDeliveryId,
      "x-sdp-event": original.trigger_type,
      "x-sdp-timestamp": String(timestampSeconds),
      "x-sdp-signature": await signV2(secrets, timestampSeconds, original.request_body),
    },
  });

  const delivery = await deliveries.createDelivery({
    id: newDeliveryId,
    organizationId: orgId,
    projectId,
    endpointId: endpoint.id,
    executionId: original.execution_id,
    workflowId: original.workflow_id,
    triggerType: original.trigger_type,
    attempt: 1,
    manual: true,
    redeliveryOf: original.id,
    requestBody: original.request_body,
    ...outcomeToDeliveryFields(outcome),
  });
  if (!delivery) {
    throw internalError("Failed to record webhook delivery");
  }

  await new AuditService(getDb(c.env)).log(c, {
    action: "redeliver",
    resourceType: "webhook_delivery",
    resourceId: delivery.id,
    metadata: { endpointId: endpoint.id, redeliveryOf: original.id, status: delivery.status },
  });

  return success(c, { delivery: toDeliveryResponse(delivery) });
};
