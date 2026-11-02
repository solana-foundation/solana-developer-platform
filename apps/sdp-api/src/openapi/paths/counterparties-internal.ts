import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  counterpartyIdParamSchema,
  counterpartyRequirementsResponseSchema,
} from "@/openapi/schemas/counterparties";
import {
  listProjectCounterpartyAccountsQuerySchema,
  listProjectCounterpartyAccountsResponseSchema,
  submitCounterpartyRequirementsRequestSchema,
} from "@/openapi/schemas/counterparties-internal";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

/** Existing dashboard operations, kept out of the public document. */
export function registerInternalCounterpartyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/counterparties/accounts",
    tags: ["Counterparties"],
    summary: "List project counterparty account summaries",
    operationId: "listProjectCounterpartyAccounts",
    description:
      "Lists active crypto-account recipient summaries across the selected project. Search matches counterparty display names. A comma-separated ids filter resolves account IDs without pagination, while the response retains page and pageSize. This internal operation does not return complete account records.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listProjectCounterpartyAccountsQuerySchema,
    },
    responses: {
      200: {
        description: "Project counterparty account summaries",
        content: jsonContent(successResponseSchema(listProjectCounterpartyAccountsResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/counterparties/{counterpartyId}/ramp-requirements/check",
    tags: ["Counterparties"],
    summary: "Submit counterparty requirements context",
    operationId: "submitCounterpartyRequirements",
    description:
      "Evaluates the counterparty's existing provider data for the named provider and direction. This internal operation accepts only provider and direction; it does not accept identity documents, bank details, or collected requirement fields. It returns the current ready, collect, or unsupported state and does not offer idempotency keys.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({ counterpartyId: counterpartyIdParamSchema }),
      body: {
        required: true,
        content: jsonContent(submitCounterpartyRequirementsRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Counterparty requirements state",
        content: jsonContent(successResponseSchema(counterpartyRequirementsResponseSchema)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 503]),
    },
  });
}
