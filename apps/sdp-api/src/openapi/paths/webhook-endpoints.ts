import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, pageQuerySchema, pageSizeQuerySchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

// Managed outbound-webhook endpoint registry: workflow send_webhook rules reference an
// endpoint by id, deliveries are signed with the endpoint's stored secret and logged
// per attempt. Signing-secret plaintext appears ONLY in create/rotate responses.
export function registerWebhookEndpointPaths(registry: OpenAPIRegistry) {
  const endpointIdParam = z
    .string()
    .openapi({ example: "webhook_endpoint_5e60b7b0-9ff1-4f4c-a56b-6db5f9e0c001" });

  const webhookEndpointSchema = z
    .object({
      id: endpointIdParam,
      url: z.string().openapi({ example: "https://example.com/hooks/sdp" }),
      label: z.string().openapi({ example: "Production receiver" }),
      description: z.string().nullable(),
      status: z.enum(["active", "disabled"]),
      secretVersion: z.number().int().openapi({ example: 1 }),
      previousSecretExpiresAt: z.string().nullable().openapi({
        description:
          "While set and in the future, deliveries also carry a signature from the previous secret (rotation grace window).",
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi("WebhookEndpoint");

  const webhookDeliverySchema = z
    .object({
      id: z.string().openapi({ example: "webhook_delivery_0f1e2d3c-4b5a-6978-8899-aabbccddeeff" }),
      endpointId: endpointIdParam,
      executionId: z.string().nullable(),
      workflowId: z.string().nullable(),
      triggerType: z.string().openapi({ example: "kyc_approved" }),
      attempt: z.number().int(),
      manual: z.boolean(),
      redeliveryOf: z.string().nullable(),
      requestBody: z.string().openapi({ description: "The signed JSON payload as sent." }),
      requestBodyTruncated: z.boolean(),
      status: z.enum(["succeeded", "failed"]),
      responseStatus: z.number().int().nullable(),
      responseBody: z
        .string()
        .nullable()
        .openapi({ description: "Receiver response body, truncated to 4096 characters." }),
      error: z.string().nullable().openapi({ example: "HTTP_502" }),
      durationMs: z.number().int().nullable(),
      createdAt: z.string(),
    })
    .openapi("WebhookDelivery");

  const envelope = (inner: z.ZodTypeAny, name: string) =>
    z.object({ data: inner, meta: z.record(z.string(), z.unknown()).optional() }).openapi(name);

  const paginatedMeta = z.object({
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    hasMore: z.boolean(),
    requestId: z.string().optional(),
  });

  const endpointListResponse = z
    .object({ data: z.array(webhookEndpointSchema), meta: paginatedMeta })
    .openapi("WebhookEndpointListResponse");
  const endpointResponse = envelope(
    z.object({ endpoint: webhookEndpointSchema }),
    "WebhookEndpointResponse"
  );
  const endpointCreateResponse = envelope(
    z.object({
      endpoint: webhookEndpointSchema,
      secret: z.string().openapi({
        description:
          "The signing secret plaintext, returned exactly once. There is no way to read it again — store it now or rotate.",
        example: "whsec_c3VwZXItc2VjcmV0LXNpZ25pbmcta2V5LW1hdGVyaWFs",
      }),
    }),
    "WebhookEndpointCreateResponse"
  );
  const endpointRotateResponse = envelope(
    z.object({
      endpoint: webhookEndpointSchema,
      secret: z.string().openapi({
        description: "The NEW signing secret plaintext, returned exactly once.",
      }),
      previousSecretExpiresAt: z.string().nullable().openapi({
        description: "Until this instant, deliveries are also signed with the previous secret.",
      }),
    }),
    "WebhookEndpointRotateResponse"
  );
  const endpointDeleteResponse = envelope(
    z.object({
      deleted: z.boolean(),
      referencingWorkflows: z.number().int().openapi({
        description:
          "Enabled send_webhook rules still referencing this endpoint; their future firings fail with ENDPOINT_DELETED.",
      }),
    }),
    "WebhookEndpointDeleteResponse"
  );
  const deliveryListResponse = z
    .object({ data: z.array(webhookDeliverySchema), meta: paginatedMeta })
    .openapi("WebhookDeliveryListResponse");
  const redeliverResponse = envelope(
    z.object({ delivery: webhookDeliverySchema }),
    "WebhookRedeliverResponse"
  );

  const createEndpointBody = z
    .object({
      url: z.string().openapi({
        description: "https-only, public host. Immutable after create.",
        example: "https://example.com/hooks/sdp",
      }),
      label: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
    })
    .openapi("WebhookEndpointCreateRequest");
  const updateEndpointBody = z
    .object({
      label: z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      status: z.enum(["active", "disabled"]).optional(),
    })
    .openapi("WebhookEndpointUpdateRequest");
  const rotateSecretBody = z
    .object({
      gracePeriodHours: z.number().min(0).max(168).optional().openapi({
        description:
          "How long the displaced secret keeps signing alongside the new one. Defaults to 24; 0 cuts over immediately.",
      }),
    })
    .openapi("WebhookEndpointRotateRequest");

  registry.registerPath({
    method: "get",
    path: "/v1/webhook-endpoints",
    tags: ["Webhook Endpoints"],
    summary: "List webhook endpoints",
    operationId: "listWebhookEndpoints",
    description: "Registered outbound-webhook endpoints for the project, newest first.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: { description: "Webhook endpoints", content: jsonContent(endpointListResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/webhook-endpoints",
    tags: ["Webhook Endpoints"],
    summary: "Create a webhook endpoint",
    operationId: "createWebhookEndpoint",
    description:
      "Registers an outbound endpoint and generates its signing secret. The secret plaintext is returned exactly once in this response.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: { content: jsonContent(createEndpointBody) },
    },
    responses: {
      201: { description: "Endpoint created", content: jsonContent(endpointCreateResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/webhook-endpoints/{endpointId}",
    tags: ["Webhook Endpoints"],
    summary: "Get a webhook endpoint",
    operationId: "getWebhookEndpoint",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ endpointId: endpointIdParam }),
    },
    responses: {
      200: { description: "Webhook endpoint", content: jsonContent(endpointResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/webhook-endpoints/{endpointId}",
    tags: ["Webhook Endpoints"],
    summary: "Update a webhook endpoint",
    operationId: "updateWebhookEndpoint",
    description: "Label, description, and enable/disable. The URL is immutable after create.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ endpointId: endpointIdParam }),
      body: { content: jsonContent(updateEndpointBody) },
    },
    responses: {
      200: { description: "Endpoint updated", content: jsonContent(endpointResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/webhook-endpoints/{endpointId}",
    tags: ["Webhook Endpoints"],
    summary: "Delete a webhook endpoint",
    operationId: "deleteWebhookEndpoint",
    description:
      "Soft delete: the endpoint disappears from reads and future rule firings fail, but its delivery log stays readable. Rules referencing it are not modified — the response counts them.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ endpointId: endpointIdParam }),
    },
    responses: {
      200: { description: "Endpoint deleted", content: jsonContent(endpointDeleteResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/webhook-endpoints/{endpointId}/rotate-secret",
    tags: ["Webhook Endpoints"],
    summary: "Rotate the signing secret",
    operationId: "rotateWebhookEndpointSecret",
    description:
      "Generates a new signing secret; the displaced one keeps signing until the grace window ends, during which deliveries carry one v1= signature per live key. The new plaintext is returned exactly once.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ endpointId: endpointIdParam }),
      body: { content: jsonContent(rotateSecretBody), required: false },
    },
    responses: {
      200: { description: "Secret rotated", content: jsonContent(endpointRotateResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/webhook-endpoints/{endpointId}/deliveries",
    tags: ["Webhook Endpoints"],
    summary: "List deliveries",
    operationId: "listWebhookDeliveries",
    description:
      "Per-attempt delivery log for the endpoint, newest first. Remains readable after the endpoint is deleted.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ endpointId: endpointIdParam }),
      query: z.object({
        page: pageQuerySchema.optional(),
        pageSize: pageSizeQuerySchema.optional(),
      }),
    },
    responses: {
      200: { description: "Deliveries", content: jsonContent(deliveryListResponse) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/webhook-endpoints/{endpointId}/deliveries/{deliveryId}/redeliver",
    tags: ["Webhook Endpoints"],
    summary: "Redeliver a logged delivery",
    operationId: "redeliverWebhookDelivery",
    description:
      "Re-sends the original request body byte-identically with fresh delivery id, timestamp and signatures, and logs the result as a new manual delivery row. Returns 200 whatever the receiver answered; 409 when the endpoint is deleted/disabled or the stored body was truncated.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        endpointId: endpointIdParam,
        deliveryId: z.string(),
      }),
    },
    responses: {
      200: { description: "Redelivery result", content: jsonContent(redeliverResponse) },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 409, 500]),
    },
  });
}
