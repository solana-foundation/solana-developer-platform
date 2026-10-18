import { EGRESS_READINESS_STATES } from "@sdp/types/health";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { z } from "zod";
import { isoDateTimeSchema } from "@/openapi/schemas/base";

export const healthResponseSchema = z
  .object({
    status: z.literal("ok").openapi({ description: "Health status." }),
    timestamp: isoDateTimeSchema.openapi({
      description: "Health check timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    version: z.string().openapi({ description: "Service version.", example: "0.1.0" }),
    environment: z.string().openapi({ description: "Runtime environment.", example: "production" }),
    releaseChannel: z.enum(SDP_RELEASE_CHANNEL_NAMES).openapi({
      description: "Release channel: which modules this deployment runs.",
      example: "experimental",
    }),
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
    commit: z.string().openapi({
      description:
        "Git commit the serving image was built from, or `local` when the image carries none.",
      example: "0123456789abcdef0123456789abcdef01234567",
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
        egress: z.enum(EGRESS_READINESS_STATES).optional().openapi({
          description:
            "Outbound internet connectivity of this instance. `pending` (not ready) while a fresh instance waits for working egress, `ok` once an outbound call succeeded, `unverified` when it stopped waiting and serves anyway. Absent where the deployment does not wait for egress.",
          example: "ok",
        }),
      })
      .openapi({ description: "Dependency health checks." }),
  })
  .openapi({ description: "Readiness check response payload." });
