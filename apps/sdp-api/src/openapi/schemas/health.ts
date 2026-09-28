import { isoDateTimeSchema, z } from "./base";

export const healthResponseSchema = z
  .object({
    status: z.literal("ok").openapi({ description: "Health status." }),
    timestamp: isoDateTimeSchema.openapi({
      description: "Health check timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    version: z.string().openapi({ description: "Service version.", example: "0.1.0" }),
    build: z.string().openapi({
      description: "Git commit the running image was built from, or `local` outside a built image.",
      example: "4e36bc2490e5b8f1d6c3a7e2f9b0d4c8a1e6f3b2",
    }),
    environment: z.string().openapi({ description: "Runtime environment.", example: "production" }),
  })
  .openapi({ description: "Health check response payload." });

export const healthReadyResponseSchema = z
  .object({
    status: z
      .enum(["ready", "not_ready"])
      .openapi({ description: "Readiness status.", example: "ready" }),
    timestamp: isoDateTimeSchema.openapi({
      description: "Readiness check timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    revision: z.string().openapi({
      description: "Cloud Run revision serving the request, or `local` outside Cloud Run.",
      example: "sdp-prod-api-public-00042-abc",
    }),
    checks: z
      .object({
        database: z.enum(["ok", "error"]).openapi({
          description: "Database connectivity status.",
          example: "ok",
        }),
        redis: z.enum(["ok", "error"]).openapi({
          description: "Redis connectivity status.",
          example: "ok",
        }),
      })
      .openapi({ description: "Dependency health checks." }),
  })
  .openapi({ description: "Readiness check response payload." });
