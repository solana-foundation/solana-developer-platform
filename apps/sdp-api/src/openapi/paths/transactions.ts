import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  unifiedTransactionsListResponseSchema,
  unifiedTransactionsQuerySchema,
} from "@/routes/transactions/schemas";
import { errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

const responseSchema = z.object({ data: unifiedTransactionsListResponseSchema });

export function registerTransactionsPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/transactions",
    tags: ["Payments"],
    summary: "List transactions",
    operationId: "listUnifiedTransactions",
    description:
      "Lists the project's transactions across SDP modules with stable cursor pagination. Results are limited to modules allowed by the caller's read permissions: payments:read for payments, private channels, and rings; earn:read for Earn; wallets:read for DvP; and tokens:read for issuance. Requesting a module without its permission returns INSUFFICIENT_PERMISSIONS. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, query: unifiedTransactionsQuerySchema },
    responses: {
      200: { description: "Unified transactions", content: jsonContent(responseSchema) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
}
