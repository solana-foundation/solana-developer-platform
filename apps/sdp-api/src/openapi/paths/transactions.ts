import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types";
import { z } from "zod";
import { publishedTransactionModules } from "@/routes/transactions/publication";
import {
  unifiedTransactionsListResponseSchemaForModules,
  unifiedTransactionsQuerySchemaForModules,
} from "@/routes/transactions/schemas";
import { errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

const BASE_OPERATION_DESCRIPTION =
  "Lists the project's transactions across SDP modules with stable cursor pagination. Results are limited to modules allowed by the caller's read permissions: payments:read for payments, private channels, and rings; wallets:read for DvP; and tokens:read for issuance. Requesting a module without its permission returns INSUFFICIENT_PERMISSIONS. `search` matches transaction id, module id, or signature as a prefix, not a substring. The endpoint is metered (60/min per credential, 240/min per organization); exceeding the quota returns 429, and 503 indicates the quota backend was unavailable.";

export interface RegisterTransactionsPathsOptions {
  /**
   * Whether the Earn family is published. Defaults to `true` — the internal
   * document always carries the full unified contract. The public document
   * passes its publication flag through, so a held-back module (earn until
   * PRO-2038) is omitted from the module selector and its branch and status
   * vocabulary are omitted from the response union (SOLA9-85): the published
   * contract is built from the published-module allowlist, never from the
   * full runtime enum.
   *
   * While modules are held back the response union also gains the
   * module-agnostic variant (`unpublishedModuleTransactionSchema`): the
   * runtime is not narrowed with the document, so an unfiltered read still
   * returns held-back rows to an authorized caller, and the published
   * response schema must stay parseable for them without naming them.
   */
  publishEarn?: boolean;
}

export function registerTransactionsPaths(
  registry: OpenAPIRegistry,
  options: RegisterTransactionsPathsOptions = {}
) {
  const modules = publishedTransactionModules(options.publishEarn ?? true);
  const holdsModulesBack = modules.length < UNIFIED_TRANSACTION_MODULES.length;
  const responseSchema = z.object({
    data: unifiedTransactionsListResponseSchemaForModules(modules, {
      openUnpublished: holdsModulesBack,
    }),
  });
  // The open-union note is a property of the held-back contract only — the
  // internal document's selector names every module, and it stays
  // byte-for-byte what it was before the hold.
  const description = holdsModulesBack
    ? `${BASE_OPERATION_DESCRIPTION} The module selector names the published modules; a response may also include transactions of modules the selector does not name, which the response union describes with its module-agnostic variant.`
    : BASE_OPERATION_DESCRIPTION;

  registry.registerPath({
    method: "get",
    path: "/v1/transactions",
    tags: ["Payments"],
    summary: "List transactions",
    operationId: "listUnifiedTransactions",
    description,
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
