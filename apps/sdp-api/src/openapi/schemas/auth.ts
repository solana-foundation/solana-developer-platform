import { sendMagicLinkSchema as sendMagicLinkSchemaBase } from "../../routes/auth/schemas";
import { z } from "./base";
import { isoDateTimeSchema, orgIdParamSchema, sessionIdParamSchema, userIdSchema } from "./base";
import { userSchema } from "./organizations";

export const sendMagicLinkResponseSchema = z
  .object({
    success: z.boolean().openapi({ description: "Delivery status.", example: true }),
    message: z.string().openapi({
      description: "Human-readable status message.",
      example: "Magic link sent.",
    }),
    expiresAt: isoDateTimeSchema.openapi({
      description: "Expiration timestamp for the magic link.",
      example: "2025-01-01T00:15:00.000Z",
    }),
  })
  .openapi({ description: "Magic link send response payload." });

export const verifyMagicLinkResponseSchema = z
  .object({
    session: z
      .object({
        id: sessionIdParamSchema,
        expiresAt: isoDateTimeSchema.openapi({
          description: "Session expiration timestamp.",
          example: "2025-01-01T01:00:00.000Z",
        }),
      })
      .openapi({ description: "Session created by the magic link." }),
    user: userSchema.openapi({ description: "Authenticated user details." }),
    organization: z
      .object({
        id: orgIdParamSchema,
        name: z.string().openapi({ description: "Organization name.", example: "Example Org" }),
        slug: z.string().openapi({ description: "Organization slug.", example: "example-org" }),
      })
      .nullable()
      .openapi({ description: "Organization context, if available." }),
  })
  .openapi({ description: "Magic link verification response payload." });

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
        tier: z.string().openapi({ description: "Organization tier.", example: "pro" }),
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
            authMethod: z.literal("magic_link").openapi({
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

export const sendMagicLinkRequestSchema = sendMagicLinkSchemaBase
  .extend({
    email: sendMagicLinkSchemaBase.shape.email.openapi({
      description: "User email to send the magic link to.",
      example: "user@example.com",
    }),
    organizationId: sendMagicLinkSchemaBase.shape.organizationId.openapi({
      description: "Optional organization to scope the login.",
      example: "org_example",
    }),
  })
  .openapi({ description: "Send magic link request body." });
