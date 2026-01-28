import {
  apiKeyCreateSchema as apiKeyCreateSchemaBase,
  apiKeyRotateSchema as apiKeyRotateSchemaBase,
  apiKeyUpdateSchema as apiKeyUpdateSchemaBase,
} from "../../routes/api-keys/schemas";
import { z } from "./base";
import {
  apiKeyIdParamSchema,
  apiKeyPrefixSchema,
  isoDateTimeSchema,
  projectIdParamSchema,
} from "./base";

export const apiKeyRoleSchema = z
  .enum(["api_admin", "api_developer", "api_readonly"])
  .openapi({ description: "API key role.", example: "api_developer" });

export const apiKeyEnvironmentSchema = z
  .enum(["sandbox", "production"])
  .openapi({ description: "API key environment.", example: "sandbox" });

export const apiKeyStatusSchema = z
  .enum(["active", "revoked", "expired"])
  .openapi({ description: "API key status.", example: "active" });

export const apiKeyListItemSchema = z
  .object({
    id: apiKeyIdParamSchema,
    name: z.string().openapi({ description: "API key name.", example: "Primary Key" }),
    keyPrefix: apiKeyPrefixSchema,
    role: apiKeyRoleSchema,
    environment: apiKeyEnvironmentSchema,
    status: apiKeyStatusSchema,
    lastUsedAt: isoDateTimeSchema.nullable().openapi({
      description: "Timestamp of the last key usage.",
      example: "2025-01-10T12:00:00.000Z",
    }),
    expiresAt: isoDateTimeSchema.nullable().openapi({
      description: "Expiration timestamp, if set.",
      example: "2025-12-31T00:00:00.000Z",
    }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "API key list item." });

export const apiKeyDetailSchema = z
  .object({
    id: apiKeyIdParamSchema,
    name: z.string().openapi({ description: "API key name.", example: "Primary Key" }),
    description: z.string().nullable().openapi({
      description: "Optional API key description.",
      example: "Used by backend service.",
    }),
    keyPrefix: apiKeyPrefixSchema,
    role: apiKeyRoleSchema,
    environment: apiKeyEnvironmentSchema,
    status: apiKeyStatusSchema,
    projectId: projectIdParamSchema
      .nullable()
      .openapi({ description: "Associated project identifier, if scoped." }),
    allowedIps: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "CIDR ranges permitted to use the key.",
        example: ["203.0.113.0/24"],
      }),
    lastUsedAt: isoDateTimeSchema.nullable().openapi({
      description: "Timestamp of the last key usage.",
      example: "2025-01-10T12:00:00.000Z",
    }),
    expiresAt: isoDateTimeSchema.nullable().openapi({
      description: "Expiration timestamp, if set.",
      example: "2025-12-31T00:00:00.000Z",
    }),
    rotatedFrom: apiKeyIdParamSchema
      .nullable()
      .openapi({ description: "Previous key identifier if rotated." }),
    rotationDeadline: isoDateTimeSchema.nullable().openapi({
      description: "Deadline before the previous key is revoked.",
      example: "2025-02-01T00:00:00.000Z",
    }),
    createdAt: isoDateTimeSchema.openapi({
      description: "Creation timestamp.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Detailed API key view." });

export const listApiKeysResponseSchema = z
  .object({
    apiKeys: z.array(apiKeyListItemSchema).openapi({ description: "API keys." }),
  })
  .openapi({ description: "List of API keys." });

export const apiKeyResponseSchema = z
  .object({
    apiKey: z
      .object({
        id: apiKeyIdParamSchema,
        name: z.string().openapi({ description: "API key name.", example: "Primary Key" }),
        key: z.string().openapi({
          description: "Full API key. Only returned once.",
          example: "sk_test_example",
        }),
        keyPrefix: apiKeyPrefixSchema,
        role: apiKeyRoleSchema,
        environment: apiKeyEnvironmentSchema,
        expiresAt: isoDateTimeSchema.nullable().openapi({
          description: "Expiration timestamp, if set.",
          example: "2025-12-31T00:00:00.000Z",
        }),
        createdAt: isoDateTimeSchema.openapi({
          description: "Creation timestamp.",
          example: "2025-01-01T00:00:00.000Z",
        }),
      })
      .openapi({ description: "API key details." }),
  })
  .openapi({ description: "API key create response payload." });

export const rotateApiKeyResponseSchema = z
  .object({
    apiKey: z
      .object({
        id: apiKeyIdParamSchema,
        name: z.string().openapi({ description: "API key name.", example: "Primary Key" }),
        key: z.string().openapi({
          description: "Full API key. Only returned once.",
          example: "sk_test_example",
        }),
        keyPrefix: apiKeyPrefixSchema,
        role: apiKeyRoleSchema,
        environment: apiKeyEnvironmentSchema,
        expiresAt: isoDateTimeSchema.nullable().openapi({
          description: "Expiration timestamp, if set.",
          example: "2025-12-31T00:00:00.000Z",
        }),
        createdAt: isoDateTimeSchema.openapi({
          description: "Creation timestamp.",
          example: "2025-01-01T00:00:00.000Z",
        }),
      })
      .openapi({ description: "New API key details." }),
    previousKey: z
      .object({
        id: apiKeyIdParamSchema,
        rotationDeadline: isoDateTimeSchema.openapi({
          description: "Deadline for revoking the previous key.",
          example: "2025-02-01T00:00:00.000Z",
        }),
      })
      .openapi({ description: "Previous API key rotation metadata." }),
  })
  .openapi({ description: "API key rotation response payload." });

export const revokeApiKeyResponseSchema = z
  .object({
    success: z.literal(true).openapi({ description: "Revocation result." }),
    revokedAt: isoDateTimeSchema.openapi({
      description: "Revocation timestamp.",
      example: "2025-01-10T12:00:00.000Z",
    }),
  })
  .openapi({ description: "API key revocation response payload." });

export const createApiKeyRequestSchema = apiKeyCreateSchemaBase
  .extend({
    name: apiKeyCreateSchemaBase.shape.name.openapi({
      description: "Friendly name for the API key.",
      example: "Primary Key",
    }),
    description: apiKeyCreateSchemaBase.shape.description.openapi({
      description: "Optional key description.",
      example: "Used by backend service.",
    }),
    role: apiKeyCreateSchemaBase.shape.role.openapi({
      description: "Role assigned to this API key.",
      example: "api_developer",
    }),
    environment: apiKeyCreateSchemaBase.shape.environment.openapi({
      description: "Target environment for the key.",
      example: "sandbox",
    }),
    allowedIps: apiKeyCreateSchemaBase.shape.allowedIps.openapi({
      description: "Optional list of CIDR ranges allowed to use the key.",
      example: ["203.0.113.0/24"],
    }),
    expiresAt: apiKeyCreateSchemaBase.shape.expiresAt.openapi({
      description: "Optional expiration timestamp.",
      example: "2025-12-31T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Create API key request body." });

export const updateApiKeyRequestSchema = apiKeyUpdateSchemaBase
  .extend({
    name: apiKeyUpdateSchemaBase.shape.name.openapi({
      description: "Updated key name.",
      example: "Primary Key Updated",
    }),
    description: apiKeyUpdateSchemaBase.shape.description.openapi({
      description: "Updated description. Use null to clear.",
      example: "Rotated key for new service.",
    }),
    allowedIps: apiKeyUpdateSchemaBase.shape.allowedIps.openapi({
      description: "Updated IP allowlist. Use null to clear.",
      example: ["203.0.113.0/24"],
    }),
    expiresAt: apiKeyUpdateSchemaBase.shape.expiresAt.openapi({
      description: "Updated expiration. Use null to clear.",
      example: "2026-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Update API key request body." });

export const rotateApiKeyRequestSchema = apiKeyRotateSchemaBase
  .extend({
    gracePeriodHours: apiKeyRotateSchemaBase.shape.gracePeriodHours.openapi({
      description: "Grace period for the old key before revocation.",
      example: 24,
    }),
  })
  .openapi({ description: "Rotate API key request body." });
