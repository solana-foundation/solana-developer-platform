import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { UNIFIED_TRANSACTION_MODULES, type UnifiedTransactionModule } from "@sdp/types";
import { z } from "zod";
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

/**
 * The published-module allowlist while Earn is held back. Deliberately an
 * explicit allowlist, not a runtime filter: a module added to
 * `UNIFIED_TRANSACTION_MODULES` stays out of the held-back public contract
 * until it is added here, which is the fail-closed direction for a
 * publication boundary. `publishEarn: true` (the internal document and the
 * publishable document after PRO-2038) bypasses the allowlist and publishes
 * the full runtime list.
 */
const PUBLISHED_TRANSACTION_MODULES_WITHOUT_EARN = [
  "payments",
  "dvp",
  "private_channels",
  "issuance",
  "rings",
] as const satisfies readonly UnifiedTransactionModule[];

function publishedTransactionModules(publishEarn: boolean) {
  return publishEarn ? UNIFIED_TRANSACTION_MODULES : PUBLISHED_TRANSACTION_MODULES_WITHOUT_EARN;
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
