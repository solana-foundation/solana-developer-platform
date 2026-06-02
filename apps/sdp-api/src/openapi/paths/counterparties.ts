import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  counterpartyIdParamSchema,
  createCounterpartyRequestSchema,
  errorResponseSchema,
  listCounterpartiesQuerySchema,
  updateCounterpartyRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import { counterpartyResponse, listCounterpartiesResponse } from "./responses";

export function registerCounterpartyPaths(registry: OpenAPIRegistry) {
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
}
