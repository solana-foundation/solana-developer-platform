import { isoDateTimeSchema, orgIdParamSchema, sessionIdParamSchema, userIdSchema, z } from "./base";

export const currentUserResponseSchema = z
  .object({
    user: z
      .object({
        id: userIdSchema,
        email: z
          .string()
          .email()
          .openapi({ description: "User email address.", example: "user@example.com" }),
        name: z
          .string()
          .nullable()
          .openapi({ description: "User display name.", example: "Example User" }),
        lastLoginAt: isoDateTimeSchema.nullable().openapi({
          description: "Timestamp of the last login, if available.",
          example: "2025-01-01T00:00:00.000Z",
        }),
        loginCount: z.number().int().openapi({
          description: "Number of successful logins.",
          example: 3,
        }),
      })
      .openapi({ description: "Authenticated user summary." }),
    organization: z
      .object({
        id: orgIdParamSchema,
        name: z.string().openapi({ description: "Organization name.", example: "Example Org" }),
        slug: z.string().openapi({ description: "Organization slug.", example: "example-org" }),
        tier: z.string().openapi({ description: "Organization tier.", example: "enterprise" }),
        role: z
          .string()
          .openapi({ description: "User role within the organization.", example: "admin" }),
      })
      .openapi({ description: "Organization context for the session." }),
    permissions: z
      .array(z.string())
      .openapi({ description: "Granted permissions.", example: ["tokens:read", "tokens:write"] }),
  })
  .openapi({ description: "Current user session payload." });

export const listSessionsResponseSchema = z
  .object({
    sessions: z
      .array(
        z
          .object({
            id: sessionIdParamSchema,
            authMethod: z.literal("session").openapi({
              description: "Authentication method used by the session.",
            }),
            ipAddress: z
              .string()
              .nullable()
              .openapi({ description: "Client IP address, if captured.", example: "203.0.113.1" }),
            userAgent: z
              .string()
              .nullable()
              .openapi({ description: "User agent string, if captured." }),
            createdAt: isoDateTimeSchema.openapi({
              description: "Session creation timestamp.",
              example: "2025-01-01T00:00:00.000Z",
            }),
            lastActivityAt: isoDateTimeSchema.nullable().openapi({
              description: "Last activity timestamp, if any.",
              example: "2025-01-01T00:10:00.000Z",
            }),
            current: z
              .boolean()
              .openapi({ description: "Whether this is the current session.", example: true }),
          })
          .openapi({ description: "Session summary." })
      )
      .openapi({ description: "Active sessions." }),
  })
  .openapi({ description: "List of active sessions." });
