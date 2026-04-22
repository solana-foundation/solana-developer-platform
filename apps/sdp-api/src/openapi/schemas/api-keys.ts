import { PERMISSIONS } from "@sdp/types";
import {
  apiKeyCreateSchema as apiKeyCreateSchemaBase,
  apiKeyRotateSchema as apiKeyRotateSchemaBase,
  apiKeyUpdateSchema as apiKeyUpdateSchemaBase,
} from "../../routes/api-keys/schemas";
import {
  apiKeyIdParamSchema,
  apiKeyPrefixSchema,
  isoDateTimeSchema,
  projectIdParamSchema,
  withOpenApi,
  z,
} from "./base";

export const apiKeyRoleSchema = z
  .enum(["api_admin", "api_developer", "api_readonly"])
  .openapi({ description: "API key role.", example: "api_developer" });

export const apiKeyEnvironmentSchema = z
  .enum(["sandbox", "production"])
  .openapi({ description: "API key environment.", example: "sandbox" });

export const apiKeyWalletScopeSchema = z.enum(["all", "selected"]).openapi({
  description: "Whether the key can use all wallets in scope or only explicitly selected wallets.",
  example: "selected",
});

export const apiKeyStatusSchema = z
  .enum(["active", "revoked", "expired", "deactivated"])
  .openapi({ description: "API key status.", example: "active" });

export const permissionSchema = z.enum(PERMISSIONS).openapi({
  description: "Permission granted to the API key.",
  example: "tokens:write",
});

export const apiKeyWalletBindingSchema = z
  .object({
    walletId: z.string().openapi({
      description: "Custody wallet ID attached to the API key.",
      example: "privy_wallet_123",
    }),
    permissions: z.array(permissionSchema).openapi({
      description: "Permissions allowed when this wallet is selected.",
      example: ["payments:write", "tokens:write"],
    }),
  })
  .openapi({ description: "Wallet-level permission binding for an API key." });

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
    permissions: z
      .array(permissionSchema)
      .nullable()
      .openapi({
        description: "Custom permissions override. Null means role defaults.",
        example: ["tokens:read", "tokens:write"],
      }),
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
    walletScope: apiKeyWalletScopeSchema,
    signingWalletId: z.string().nullable().openapi({
      description: "Default custody wallet bound to this API key for signing.",
      example: "privy_wallet_123",
    }),
    signingWalletIds: z.array(z.string()).openapi({
      description: "All custody wallet IDs bound to this API key.",
      example: ["privy_wallet_123", "dfns_wallet_456"],
    }),
    walletBindings: z.array(apiKeyWalletBindingSchema).openapi({
      description: "Wallet bindings and wallet-level permission sets for this API key.",
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
    name: withOpenApi(apiKeyCreateSchemaBase.shape.name, {
      description: "Friendly name for the API key.",
      example: "Primary Key",
    }),
    description: withOpenApi(apiKeyCreateSchemaBase.shape.description, {
      description: "Optional key description.",
      example: "Used by backend service.",
    }),
    role: withOpenApi(apiKeyCreateSchemaBase.shape.role, {
      description: "Role assigned to this API key.",
      example: "api_developer",
    }),
    environment: withOpenApi(apiKeyCreateSchemaBase.shape.environment, {
      description: "Target environment for the key.",
      example: "sandbox",
    }),
    walletScope: withOpenApi(apiKeyCreateSchemaBase.shape.walletScope, {
      description:
        "Explicit wallet access mode. Use 'all' to allow every wallet in scope or 'selected' to bind specific wallets.",
      example: "selected",
    }),
    allowedIps: withOpenApi(apiKeyCreateSchemaBase.shape.allowedIps, {
      description: "Optional list of CIDR ranges allowed to use the key.",
      example: ["203.0.113.0/24"],
    }),
    expiresAt: withOpenApi(apiKeyCreateSchemaBase.shape.expiresAt, {
      description: "Optional expiration timestamp.",
      example: "2025-12-31T00:00:00.000Z",
    }),
    permissions: withOpenApi(apiKeyCreateSchemaBase.shape.permissions, {
      description: "Optional explicit permission set. Requires admin access.",
      example: ["tokens:read", "tokens:write"],
    }),
    signingWalletId: withOpenApi(apiKeyCreateSchemaBase.shape.signingWalletId, {
      description: "Optional default custody wallet ID to bind this key to.",
      example: "privy_wallet_123",
    }),
    signingWalletIds: withOpenApi(apiKeyCreateSchemaBase.shape.signingWalletIds, {
      description:
        "Optional list of custody wallet IDs to bind to this key. The first wallet becomes default unless signingWalletId is explicitly set.",
      example: ["privy_wallet_123", "dfns_wallet_456"],
    }),
    walletBindings: withOpenApi(apiKeyCreateSchemaBase.shape.walletBindings, {
      description:
        "Optional wallet-level permission bindings. Use this to attach multiple wallets with scoped permissions.",
    }),
    provisionWallet: withOpenApi(apiKeyCreateSchemaBase.shape.provisionWallet, {
      description: "If true, provisions a new custody wallet and binds it to the key.",
      example: false,
    }),
    walletLabel: withOpenApi(apiKeyCreateSchemaBase.shape.walletLabel, {
      description: "Optional label for a provisioned wallet.",
      example: "Mint authority wallet",
    }),
    walletPurpose: withOpenApi(apiKeyCreateSchemaBase.shape.walletPurpose, {
      description: "Optional purpose for a provisioned wallet.",
      example: "mint_authority",
    }),
  })
  .openapi({ description: "Create API key request body." });

export const updateApiKeyRequestSchema = apiKeyUpdateSchemaBase
  .extend({
    name: withOpenApi(apiKeyUpdateSchemaBase.shape.name, {
      description: "Updated key name.",
      example: "Primary Key Updated",
    }),
    description: withOpenApi(apiKeyUpdateSchemaBase.shape.description, {
      description: "Updated description. Use null to clear.",
      example: "Rotated key for new service.",
    }),
    walletScope: withOpenApi(apiKeyUpdateSchemaBase.shape.walletScope, {
      description:
        "Updated wallet access mode. Provide this when changing wallet bindings, or by itself to reset the key to all wallets.",
      example: "all",
    }),
    allowedIps: withOpenApi(apiKeyUpdateSchemaBase.shape.allowedIps, {
      description: "Updated IP allowlist. Use null to clear.",
      example: ["203.0.113.0/24"],
    }),
    expiresAt: withOpenApi(apiKeyUpdateSchemaBase.shape.expiresAt, {
      description: "Updated expiration. Use null to clear.",
      example: "2026-01-01T00:00:00.000Z",
    }),
    permissions: withOpenApi(apiKeyUpdateSchemaBase.shape.permissions, {
      description: "Updated explicit permission set. Use null to revert to role defaults.",
      example: ["tokens:read", "tokens:write"],
    }),
    signingWalletId: withOpenApi(apiKeyUpdateSchemaBase.shape.signingWalletId, {
      description: "Updated default signing wallet binding. Use null to clear all wallet bindings.",
      example: "privy_wallet_123",
    }),
    signingWalletIds: withOpenApi(apiKeyUpdateSchemaBase.shape.signingWalletIds, {
      description:
        "Updated list of wallet IDs bound to this key. Use null to clear all wallet bindings.",
      example: ["privy_wallet_123", "dfns_wallet_456"],
    }),
    walletBindings: withOpenApi(apiKeyUpdateSchemaBase.shape.walletBindings, {
      description:
        "Updated wallet-level permission bindings. Use null to clear all wallet bindings.",
    }),
  })
  .openapi({ description: "Update API key request body." });

export const rotateApiKeyRequestSchema = apiKeyRotateSchemaBase
  .extend({
    gracePeriodHours: withOpenApi(apiKeyRotateSchemaBase.shape.gracePeriodHours, {
      description: "Grace period for the old key before revocation.",
      example: 24,
    }),
  })
  .openapi({ description: "Rotate API key request body." });
