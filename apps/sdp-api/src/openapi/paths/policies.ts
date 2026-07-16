import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { errorResponseSchema, policyControlInventoryQuerySchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import { policyControlInventoryResponse } from "./responses";

export function registerPolicyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/policies",
    tags: ["Policies"],
    summary: "List policy controls",
    operationId: "listPolicyControls",
    description:
      "Lists wallet and API-key control targets in one paginated inventory. Every target, profile, binding, and evaluation is scoped to the authenticated organization and exact project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: policyControlInventoryQuerySchema,
    },
    responses: {
      200: {
        description: "Policy-control inventory",
        content: jsonContent(policyControlInventoryResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
}
