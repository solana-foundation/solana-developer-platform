import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  errorResponseSchema,
  signTransactionRequestSchema,
  signingRequestIdParamSchema,
  submitTransactionRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  custodySignAsyncResponse,
  custodySignSyncResponse,
  signingStatusResponse,
  submitTransactionResponse,
} from "./responses";

export function registerTransactionPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/transactions/submit",
    tags: ["Transactions"],
    summary: "Submit signed transaction",
    operationId: "submitTransaction",
    description: "Submits a signed transaction to Solana.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(submitTransactionRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Transaction submitted",
        content: jsonContent(submitTransactionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/transactions/sign",
    tags: ["Transactions"],
    summary: "Sign transaction",
    operationId: "signTransaction",
    description: "Requests custody signing for a transaction.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(signTransactionRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Signed transaction",
        content: jsonContent(custodySignSyncResponse),
      },
      202: {
        description: "Signing request pending approval",
        content: jsonContent(custodySignAsyncResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/transactions/signing/{requestId}",
    tags: ["Transactions"],
    summary: "Get signing status",
    operationId: "getSigningStatus",
    description: "Fetches status for a custody signing request.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        requestId: signingRequestIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Signing status",
        content: jsonContent(signingStatusResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
}
