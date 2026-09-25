import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { publishedTransactionModules } from "@/routes/transactions/publication";
import {
  unifiedTransactionsListResponseSchemaForModules,
  unifiedTransactionsQuerySchemaForModules,
} from "@/routes/transactions/schemas";
import { errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

export interface RegisterTransactionsPathsOptions {
  /**
   * Whether the Earn family is published. Defaults to `true` — the internal
   * document always carries the full unified contract. The public document
   * passes its publication flag through, so a held-back module (earn until
   * PRO-2038) is omitted from the module selector and its branch and status
   * vocabulary are omitted from the response union (SOLA9-85): the published
   * contract is built from the published-module allowlist, never from the
   * full runtime enum.
   */
  publishEarn?: boolean;
}

export function registerTransactionsPaths(
  registry: OpenAPIRegistry,
  options: RegisterTransactionsPathsOptions = {}
) {
  const modules = publishedTransactionModules(options.publishEarn ?? true);
  const responseSchema = z.object({
    data: unifiedTransactionsListResponseSchemaForModules(modules),
  });

  registry.registerPath({
    method: "get",
    path: "/v1/transactions",
    tags: ["Payments"],
    summary: "List transactions",
    operationId: "listUnifiedTransactions",
    description:
      "Lists the project's transactions across SDP modules with stable cursor pagination. Results are limited to modules allowed by the caller's read permissions: payments:read for payments, private channels, and rings; wallets:read for DvP; and tokens:read for issuance. Requesting a module without its permission returns INSUFFICIENT_PERMISSIONS. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: unifiedTransactionsQuerySchemaForModules(modules),
    },
    responses: {
      200: { description: "Unified transactions", content: jsonContent(responseSchema) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });
}
