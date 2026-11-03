import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { healthReadyResponseSchema, healthResponseSchema } from "@/openapi/schemas/health";
import { jsonContent } from "./helpers";

export function registerHealthPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "Health check",
    operationId: "healthCheck",
    description: "Returns service health and build metadata.",
    security: [],
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
    security: [],
    responses: {
      200: {
        description: "Service is ready",
        content: jsonContent(healthReadyResponseSchema.extend({ status: z.literal("ready") })),
      },
      503: {
        description: "Service is not ready",
        // Its own example: the schema's field examples describe a ready instance.
        content: jsonContent(
          healthReadyResponseSchema.extend({ status: z.literal("not_ready") }).openapi({
            example: {
              status: "not_ready",
              timestamp: "2025-01-01T00:00:00.000Z",
              revision: "sdp-prod-api-public-00042-abc",
              commit: "0123456789abcdef0123456789abcdef01234567",
              checks: { database: "ok", redis: "error", egress: "ok" },
            },
          })
        ),
      },
    },
  });
}
