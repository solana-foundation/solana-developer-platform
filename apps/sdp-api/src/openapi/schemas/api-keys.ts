import { API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import { API_KEY_WALLET_SCOPES } from "@sdp/types/api-keys";
import { z } from "zod";
import {
  apiKeyCreateSchema as apiKeyCreateSchemaBase,
  apiKeyRotateSchema as apiKeyRotateSchemaBase,
  apiKeyUpdateSchema as apiKeyUpdateSchemaBase,
} from "@/routes/api-keys/schemas";
import {
  apiKeyIdParamSchema,
  apiKeyPrefixSchema,
  isoDateTimeSchema,
  projectIdParamSchema,
  withOpenApi,
} from "./base";

export const apiKeyGrantSchema = z.enum(API_KEY_GRANTABLE_ACTIONS).openapi({
  description:
    "An action the key may perform, `module.verb`. `manage` and `execute` each imply the same module's `read`; nothing else implies another action.",
  example: "transfers.execute",
});

export const apiKeyGrantsSchema = z.array(apiKeyGrantSchema).openapi({
  description:
    "The actions this key holds. An explicit list: there is no role and no wildcard, and an action added to SDP later is granted to no existing key.",
  example: ["transfers.execute", "counterparties.read", "wallets.read"],
});

export const apiKeyEnvironmentSchema = z
  .enum(["sandbox", "production"])
  .openapi({ description: "API key environment.", example: "sandbox" });

export const apiKeyWalletScopeSchema = z.enum(API_KEY_WALLET_SCOPES).openapi({
  description:
    "Which custody wallets the key may sign with: `all` wallets in its project, or only the `selected` ones in `walletIds`. A `selected` key with no wallets signs with no custody wallet (the fee sponsor is outside wallet scope). The scope applies when SDP signs; it also narrows the key's wallet list and wallet detail reads, while every other read covers the whole project.",
  example: "selected",
});

export const apiKeyWalletIdsSchema = z.array(z.string()).openapi({
  description:
    "The custody wallets (`id` from `GET /v1/wallets`, `cwlt_...`) a `selected` key may sign with. Empty for `all`.",
  example: ["cwlt_0f2c8c1e"],
});

export const apiKeyStatusSchema = z
  .enum(["active", "revoked", "expired", "deactivated"])
  .openapi({ description: "API key status.", example: "active" });

export const apiKeyListItemSchema = z
  .object({
    id: apiKeyIdParamSchema,
    name: z.string().openapi({ description: "API key name.", example: "Primary Key" }),
    keyPrefix: apiKeyPrefixSchema,
    grants: apiKeyGrantsSchema,
    environment: apiKeyEnvironmentSchema,
    status: apiKeyStatusSchema,
    walletScope: apiKeyWalletScopeSchema,
    walletIds: apiKeyWalletIdsSchema,
    lastUsedAt: isoDateTimeSchema.nullable().openapi({
      description: "Timestamp of the last key usage.",
      example: "2025-01-10T12:00:00.000Z",
    }),
    expiresAt: isoDateTimeSchema.nullable().openapi({
      description: "Expiration timestamp, if set.",
      example: "2025-12-31T00:00:00.000Z",
    }),
    rotationDeadline: isoDateTimeSchema.nullable().openapi({
      description:
        "When this key stops working because it was rotated; null unless it is in its rotation grace period.",
      example: null,
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
    grants: apiKeyGrantsSchema,
    environment: apiKeyEnvironmentSchema,
    status: apiKeyStatusSchema,
    projectId: projectIdParamSchema.openapi({
      description: "Associated project identifier.",
    }),
    allowedIps: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "IPv4/IPv6 addresses or CIDR ranges permitted to use the key.",
        example: ["203.0.113.0/24"],
      }),
    walletScope: apiKeyWalletScopeSchema,
    walletIds: apiKeyWalletIdsSchema,
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
        grants: apiKeyGrantsSchema,
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
        grants: apiKeyGrantsSchema,
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
    recurringPayments: z
      .object({
        canceled: z.array(z.string()).openapi({
          description: "Recurring payments this key activated that are now canceled.",
        }),
        failed: z.array(z.string()).openapi({
          description: "Recurring payments that could not be canceled; cancel them individually.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "Null unless the request set `cancelRecurringPayments`. The key is revoked either way.",
      }),
  })
  .openapi({ description: "API key revocation response payload." });

/** Fields keys used before grants and wallet scope: refused with a 400, never documented. */
const retiredApiKeyFieldMask = {
  role: true,
  permissions: true,
  allowedOperations: true,
  signingWalletId: true,
  signingWalletIds: true,
  walletBindings: true,
} as const;

export const createApiKeyRequestSchema = apiKeyCreateSchemaBase
  .omit({
    connectionId: true,
    provisionWallet: true,
    walletLabel: true,
    walletPurpose: true,
    ...retiredApiKeyFieldMask,
  })
  .extend({
    name: withOpenApi(apiKeyCreateSchemaBase.shape.name, {
      description: "Friendly name for the API key.",
      example: "Primary Key",
    }),
    description: withOpenApi(apiKeyCreateSchemaBase.shape.description, {
      description: "Optional key description.",
      example: "Used by backend service.",
    }),
    grants: withOpenApi(apiKeyGrantsSchema, {
      description:
        "The actions the key holds, `module.verb`. Required; an empty list grants nothing. Unknown actions, and actions no API key may hold (`api_keys.*`, `members.*`, `organizations.manage`, `projects.manage`, any `*.configure`), are refused with 400, as are actions of a module this deployment's release channel does not run. You can grant only actions you hold yourself.",
      example: ["transfers.execute", "counterparties.read", "wallets.read"],
    }),
    walletScope: withOpenApi(apiKeyCreateSchemaBase.shape.walletScope, {
      description:
        "Which custody wallets the key may sign with: `all` in its project, or only the `selected` ones in `walletIds`. Required.",
      example: "selected",
    }),
    walletIds: withOpenApi(apiKeyCreateSchemaBase.shape.walletIds, {
      description:
        "Custody wallet ids (`id` from `GET /v1/wallets`) a `selected` key may sign with. Not allowed with `all`. Omitted or empty, a `selected` key signs with no custody wallet.",
      example: ["cwlt_0f2c8c1e"],
    }),
    allowedIps: withOpenApi(apiKeyCreateSchemaBase.shape.allowedIps, {
      description: "Optional list of IPv4/IPv6 addresses or CIDR ranges allowed to use the key.",
      example: ["203.0.113.0/24"],
    }),
    expiresAt: withOpenApi(apiKeyCreateSchemaBase.shape.expiresAt, {
      description: "Optional expiration timestamp.",
      example: "2025-12-31T00:00:00.000Z",
    }),
  })
  .openapi({
    description: "Create API key request body.",
    example: {
      name: "Primary Key",
      grants: ["transfers.execute", "counterparties.read", "wallets.read"],
      walletScope: "selected",
      walletIds: ["cwlt_0f2c8c1e"],
    },
  });

export const updateApiKeyRequestSchema = apiKeyUpdateSchemaBase
  .omit(retiredApiKeyFieldMask)
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
        "Replaces the key's wallet scope. With `selected`, `walletIds` replaces its wallets (omitted: none). Omit both to keep the current scope.",
      example: "selected",
    }),
    walletIds: withOpenApi(apiKeyUpdateSchemaBase.shape.walletIds, {
      description: 'Custody wallet ids for a `selected` key. Requires `walletScope: "selected"`.',
      example: ["cwlt_0f2c8c1e"],
    }),
    allowedIps: withOpenApi(apiKeyUpdateSchemaBase.shape.allowedIps, {
      description: "Updated IPv4/IPv6 address or CIDR allowlist. Use null to clear.",
      example: ["203.0.113.0/24"],
    }),
    grants: withOpenApi(apiKeyGrantsSchema.optional(), {
      description:
        "Replaces the key's grants. Omit to keep them. The same rules as on create apply, except that an action the key already holds may be sent back even when this deployment's release channel no longer runs its module.",
      example: ["transfers.read", "transfers.execute"],
    }),
    expiresAt: withOpenApi(apiKeyUpdateSchemaBase.shape.expiresAt, {
      description: "Updated expiration. Use null to clear.",
      example: "2026-01-01T00:00:00.000Z",
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
