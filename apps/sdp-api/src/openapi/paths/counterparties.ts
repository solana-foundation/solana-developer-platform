import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  counterpartyAccountPathParamsSchema,
  counterpartyIdParamSchema,
  createCounterpartyAccountRequestSchema,
  createCounterpartyRequestSchema,
  errorResponseSchema,
  listCounterpartiesQuerySchema,
  listCounterpartyAccountsQuerySchema,
  updateCounterpartyAccountRequestSchema,
  updateCounterpartyRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import {
  counterpartyAccountResponse,
  counterpartyFieldOptionsResponse,
  counterpartyResponse,
  listCounterpartiesResponse,
  listCounterpartyAccountsResponse,
} from "./responses";

export function registerCounterpartyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/counterparties/metadata",
    tags: ["Counterparties"],
    summary: "Get counterparty field options",
    operationId: "getCounterpartyFieldOptions",
    description:
      "Returns the enum option sets and country list needed to build a counterparty form.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Counterparty field options",
        content: jsonContent(counterpartyFieldOptionsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/counterparties",
    tags: ["Counterparties"],
    summary: "List counterparties",
    operationId: "listCounterparties",
    description: "Lists counterparties for the authenticated organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listCounterpartiesQuerySchema,
    },
    responses: {
      200: {
        description: "Counterparties list",
        content: jsonContent(listCounterpartiesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/counterparties",
    tags: ["Counterparties"],
    summary: "Create counterparty",
    operationId: "createCounterparty",
    description:
      "Creates a counterparty. If externalId is provided, it must be unique within the organization.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createCounterpartyRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Counterparty created",
        content: jsonContent(counterpartyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/counterparties/{counterpartyId}",
    tags: ["Counterparties"],
    summary: "Get counterparty",
    operationId: "getCounterparty",
    description: "Gets counterparty details by id.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        counterpartyId: counterpartyIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Counterparty",
        content: jsonContent(counterpartyResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/counterparties/{counterpartyId}",
    tags: ["Counterparties"],
    summary: "Update counterparty",
    operationId: "updateCounterparty",
    description:
      "Updates counterparty attributes. At least one field must be provided. Use null on externalId to clear it.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        counterpartyId: counterpartyIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateCounterpartyRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Counterparty updated",
        content: jsonContent(counterpartyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/counterparties/{counterpartyId}",
    tags: ["Counterparties"],
    summary: "Archive counterparty",
    operationId: "archiveCounterparty",
    description: "Archives a counterparty. Archived counterparties are hidden from default lists.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        counterpartyId: counterpartyIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Counterparty archived",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/counterparties/{counterpartyId}/accounts",
    tags: ["Counterparties"],
    summary: "List counterparty accounts",
    operationId: "listCounterpartyAccounts",
    description:
      "Lists payment accounts for a counterparty. Crypto-wallet accounts can be used by payment flows that send funds to a counterparty wallet.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        counterpartyId: counterpartyIdParamSchema,
      }),
      query: listCounterpartyAccountsQuerySchema,
    },
    responses: {
      200: {
        description: "Counterparty account list",
        content: jsonContent(listCounterpartyAccountsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/counterparties/{counterpartyId}/accounts",
    tags: ["Counterparties"],
    summary: "Create counterparty account",
    operationId: "createCounterpartyAccount",
    description:
      'Creates a payment account for a counterparty. For accountKind "crypto_wallet", details.network must be "solana" and details.address must be a Solana wallet address.',
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        counterpartyId: counterpartyIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(createCounterpartyAccountRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Counterparty account created",
        content: jsonContent(counterpartyAccountResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}",
    tags: ["Counterparties"],
    summary: "Get counterparty account",
    operationId: "getCounterpartyAccount",
    description: "Gets a counterparty payment account by id.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: counterpartyAccountPathParamsSchema,
    },
    responses: {
      200: {
        description: "Counterparty account",
        content: jsonContent(counterpartyAccountResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}",
    tags: ["Counterparties"],
    summary: "Update counterparty account",
    operationId: "updateCounterpartyAccount",
    description: "Updates a counterparty payment account. At least one field must be provided.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: counterpartyAccountPathParamsSchema,
      body: {
        required: true,
        content: jsonContent(updateCounterpartyAccountRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Counterparty account updated",
        content: jsonContent(counterpartyAccountResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/counterparties/{counterpartyId}/accounts/{counterpartyAccountId}",
    tags: ["Counterparties"],
    summary: "Archive counterparty account",
    operationId: "archiveCounterpartyAccount",
    description:
      "Archives a counterparty payment account. Archived accounts are hidden from default lists.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: counterpartyAccountPathParamsSchema,
    },
    responses: {
      204: {
        description: "Counterparty account archived",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });
}
