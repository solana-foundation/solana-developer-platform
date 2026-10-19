import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema } from "@/openapi/schemas/base";
import {
  unifiedTransactionsListResponseSchema,
  unifiedTransactionsQuerySchema,
} from "@/routes/transactions/schemas";
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
      "Lists the project's transactions across SDP modules with stable cursor pagination. Requires `transactions.read`. Every row also needs the `read` action of the module it comes from (which its `manage` or `execute` includes): a Payments row needs `transfers.read` for a transfer or deposit, `transfer_batches.read` for a batch item, `recurring.read` for a recurring collection, `payment_requests.read` for a payment request's fulfilment, and `onramp.read` or `offramp.read` for a ramp transfer; every other module's rows need that module's `read`. Rows the caller cannot read are left out. Requesting a module, or a Payments `kind`, without its action returns 403 INSUFFICIENT_PERMISSIONS naming it. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.",
    security: [{ apiKeyAuth: [] }],
    request: { headers: projectScopeHeaders, query: unifiedTransactionsQuerySchema },
    responses: {
      200: { description: "Unified transactions", content: jsonContent(responseSchema) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
}
