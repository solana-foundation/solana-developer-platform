import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  earnButtonConfigurationPublicParamsSchema,
  earnButtonConfigurationSchema,
} from "@/routes/earn/schemas";
import { errorResponseSchema } from "../schemas/base";
import {
  earnButtonConfigurationResponse,
  publicEarnButtonConfigurationResponse,
} from "../schemas/earn";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";

const earnConfigurationSecurity: Array<Record<string, string[]>> = [
  { apiKeyAuth: [] },
  { clerkBearerAuth: [] },
  { sessionCookie: [] },
];

export function registerEarnPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/earn/button-configurations/public/{publicToken}",
    tags: ["Earn"],
    summary: "Get a public Earn button handoff",
    operationId: "getPublicEarnButtonConfiguration",
    description:
      "Resolves the style and strategy for an engineering handoff token without exposing tenant metadata or credentials.",
    request: {
      params: earnButtonConfigurationPublicParamsSchema,
    },
    responses: {
      200: {
        description: "Public Earn button handoff",
        content: jsonContent(publicEarnButtonConfigurationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/button-configurations/current",
    tags: ["Earn"],
    summary: "Get the current Earn button configuration",
    operationId: "getEarnButtonConfiguration",
    description:
      "Gets the saved Earn button configuration for the active organization and project.",
    security: earnConfigurationSecurity,
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Earn button configuration",
        content: jsonContent(earnButtonConfigurationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500]),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/earn/button-configurations/current",
    tags: ["Earn"],
    summary: "Save the current Earn button configuration",
    operationId: "upsertEarnButtonConfiguration",
    description:
      "Validates deposit availability before saving the selected strategy and appearance for the active organization and project.",
    security: earnConfigurationSecurity,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnButtonConfigurationSchema),
      },
    },
    responses: {
      200: {
        description: "Earn button configuration saved",
        content: jsonContent(earnButtonConfigurationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });
}
