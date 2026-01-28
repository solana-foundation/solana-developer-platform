import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { healthReadyResponseSchema, healthResponseSchema } from "../schemas";
import { jsonContent } from "./helpers";

export function registerHealthPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "Health check",
    operationId: "healthCheck",
    description: "Returns service health and build metadata.",
    responses: {
      200: {
        description: "Service is healthy",
        content: jsonContent(healthResponseSchema),
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/health/ready",
    tags: ["Health"],
    summary: "Readiness check",
    operationId: "healthReadiness",
    description: "Performs readiness checks for downstream dependencies.",
    responses: {
      200: {
        description: "Service is ready",
        content: jsonContent(healthReadyResponseSchema),
      },
      503: {
        description: "Service is not ready",
        content: jsonContent(healthReadyResponseSchema),
      },
    },
  });
}
