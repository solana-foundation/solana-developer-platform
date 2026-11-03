import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { transferResponseSchema } from "@/openapi/schemas/payments";
import {
  cancelRampTransferRequestSchema,
  createOfframpQuoteRequestSchema,
  estimateOfframpRequestSchema,
  estimateOnrampRequestSchema,
  offrampQuoteResponseSchema,
  rampEstimatesResponseSchema,
} from "@/openapi/schemas/ramps-internal";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

/** Existing ramp operations that have not been promoted into public OpenAPI. */
export function registerInternalRampPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/onramp/estimate",
    tags: ["Payments"],
    summary: "Estimate on-ramp across providers",
    operationId: "estimatePaymentOnramp",
    description:
      "Estimates the requested fiat-to-crypto corridor across eligible providers. Returns an estimates array containing each provider's ok, unsupported, or error result, including policy refusals and amount limits. It creates no checkout and accepts no idempotency key.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: { required: true, content: jsonContent(estimateOnrampRequestSchema) },
    },
    responses: {
      200: {
        description: "Per-provider on-ramp estimates",
        content: jsonContent(successResponseSchema(rampEstimatesResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/offramp/estimate",
    tags: ["Payments"],
    summary: "Estimate off-ramp across providers",
    operationId: "estimatePaymentOfframp",
    description:
      "Estimates the requested crypto-to-fiat corridor across eligible providers and returns every provider outcome. Amounts, rates, and fees are decimal strings. It creates no sale and accepts no idempotency key.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: { required: true, content: jsonContent(estimateOfframpRequestSchema) },
    },
    responses: {
      200: {
        description: "Per-provider off-ramp estimates",
        content: jsonContent(successResponseSchema(rampEstimatesResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/offramp/start",
    tags: ["Payments"],
    summary: "Start off-ramp",
    operationId: "createPaymentOfframpQuote",
    description:
      "Starts a tracked provider flow and creates an SDP transfer record using an exact source SDP wallet ID. MoonPay returns a hosted checkout; Stripe off-ramp currently returns 400 as unsupported. The provider flow determines the eventual deposit instructions. This operation does not automatically fund the crypto deposit and offers no idempotency key.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: { required: true, content: jsonContent(createOfframpQuoteRequestSchema) },
    },
    responses: {
      200: {
        description: "Off-ramp quote and transfer ID",
        content: jsonContent(successResponseSchema(offrampQuoteResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 502, 503]),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/payments/ramps/transfers/cancel",
    tags: ["Payments"],
    summary: "Cancel ramp transfer",
    operationId: "cancelPaymentRampTransfer",
    description:
      "Cancels an eligible on-ramp or off-ramp SDP transfer and returns the transfer record. For off-ramps, provider-side sale cancellation is best-effort after SDP records cancellation. A non-cancelable or changed transfer is refused; this endpoint accepts no idempotency key.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: { required: true, content: jsonContent(cancelRampTransferRequestSchema) },
    },
    responses: {
      200: {
        description: "Canceled ramp transfer",
        content: jsonContent(successResponseSchema(transferResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500, 503]),
    },
  });
}
