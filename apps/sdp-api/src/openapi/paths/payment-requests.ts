import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  createdPaymentRequestResponseSchema,
  createPaymentRequestBodySchema,
  paymentLinkMetadataResponseSchema,
  paymentLinkPathSchema,
  paymentLinkResponseSchema,
  paymentRequestLinkResponseSchema,
  paymentRequestListQuerySchema,
  paymentRequestListResponseSchema,
  paymentRequestPathSchema,
  paymentRequestRecordResponseSchema,
  preparedPaymentLinkResponseSchema,
  preparePaymentLinkBodySchema,
} from "@/openapi/schemas/payment-requests";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";

/** Existing request and Solana Pay routes. Registration is internal-only. */
export function registerPaymentRequestPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/payments/requests",
    tags: ["Payments"],
    summary: "Create payment request",
    operationId: "createPaymentRequest",
    description:
      "Creates a payment request for a provider wallet ID and token mint address. Returns the record directly in data, including the bearer publicToken for the payment link. No payment is executed by creation.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeWithDeclaredIdempotencyHeaders({
        key: "accepted",
        serverErrors: "store",
      }),
      body: { required: true, content: jsonContent(createPaymentRequestBodySchema) },
    },
    responses: {
      201: {
        description: "Payment request created, including its bearer link token",
        content: jsonContent(successResponseSchema(createdPaymentRequestResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 500]),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/payments/requests",
    tags: ["Payments"],
    summary: "List payment requests",
    operationId: "listPaymentRequests",
    description:
      "Returns one page of payment requests in data.paymentRequests, with pagination fields in data. Read responses omit bearer link tokens.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, query: paymentRequestListQuerySchema },
    responses: {
      200: {
        description: "Payment request records without link credentials",
        content: jsonContent(successResponseSchema(paymentRequestListResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/payments/requests/{paymentRequestId}",
    tags: ["Payments"],
    summary: "Get payment request",
    operationId: "getPaymentRequest",
    description:
      "Reads one payment request, with its lifecycle and fulfillment fields, directly in data. The response omits the bearer link token.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: paymentRequestPathSchema },
    responses: {
      200: {
        description: "Payment request without its link credential",
        content: jsonContent(successResponseSchema(paymentRequestRecordResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/payments/requests/{paymentRequestId}/link-token",
    tags: ["Payments"],
    summary: "Get payment request link token",
    operationId: "getPaymentRequestLink",
    description:
      "Returns id and publicToken for an existing payment request. This manage-level operation discloses the bearer credential used by /pay; read permission alone cannot retrieve it.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, params: paymentRequestPathSchema },
    responses: {
      200: {
        description: "Payment request bearer link token",
        content: jsonContent(successResponseSchema(paymentRequestLinkResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/pay/{publicToken}",
    tags: ["Payments"],
    summary: "Read payment link",
    operationId: "getPaymentLink",
    description:
      "Reads payment details using the link's bearer token, without an API key or Clerk session. Returns a bare JSON object. The stored project's environment selects the network; solanaPayUrl is null when the request is no longer payable or has no exact custody wallet association.",
    security: [],
    request: { params: paymentLinkPathSchema },
    responses: {
      200: { description: "Payment link details", content: jsonContent(paymentLinkResponseSchema) },
      ...errorResponses(errorResponseSchema, [400, 403, 404, 429, 500]),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/pay/{publicToken}/tx",
    tags: ["Payments"],
    summary: "Get payment link transaction metadata",
    operationId: "getPaymentLinkMetadata",
    description:
      "Returns the Solana Pay label and icon as a bare JSON object. This metadata operation does not validate the link's existence or payment state.",
    security: [],
    request: { params: paymentLinkPathSchema },
    responses: {
      200: {
        description: "Solana Pay display metadata",
        content: jsonContent(paymentLinkMetadataResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [429, 500]),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/pay/{publicToken}/tx",
    tags: ["Payments"],
    summary: "Prepare sponsored payment link transaction",
    operationId: "preparePaymentLinkTransaction",
    description:
      "Returns a fee-sponsored transaction for the supplied payer account to sign. It is not signed by the payer or broadcast by this operation. The server reconciles existing payment state and owns the sponsorship claim; a live claim held by another payer returns 429 with Retry-After. This operation accepts no idempotency key and must not be automatically retried. The response is a bare object containing transaction and message.",
    security: [],
    request: {
      params: paymentLinkPathSchema,
      body: { required: true, content: jsonContent(preparePaymentLinkBodySchema) },
    },
    responses: {
      200: {
        description: "Partially signed transaction for the payer",
        content: jsonContent(preparedPaymentLinkResponseSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 403, 404, 409, 429, 500, 503]),
    },
  });
}
