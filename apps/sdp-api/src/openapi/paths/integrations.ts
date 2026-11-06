import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { errorResponseSchema } from "@/openapi/schemas/base";
import { errorResponses, jsonContent } from "./helpers";
import { projectIntegrationsResponse } from "./responses";

export function registerIntegrationPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/integrations",
    tags: ["Projects"],
    summary: "List project integrations",
    operationId: "listProjectIntegrations",
    description:
      "Lists the project's integrations and how each reaches the project. A provider is listed only when the project can use it, decided by the same rule that admits its use, so an integration listed here is never refused for availability at its entry point. The project comes from the `x-project-id` header, or from the API key's own project.",
    security: [{ apiKeyAuth: [] }],
    responses: {
      200: {
        description: "Project integrations",
        content: jsonContent(projectIntegrationsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });
}
