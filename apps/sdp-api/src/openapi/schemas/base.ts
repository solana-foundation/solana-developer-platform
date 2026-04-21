import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export { z };

type OpenApiArgs = [unknown, unknown?, unknown?];
type OpenApiMethod = (this: z.ZodType, ...args: OpenApiArgs) => z.ZodType;

export function withOpenApi<T extends z.ZodType>(schema: T, ...args: OpenApiArgs): T {
  const openapi =
    (schema as { openapi?: OpenApiMethod }).openapi ??
    (z.ZodType as unknown as { prototype: { openapi: OpenApiMethod } }).prototype.openapi;

  return openapi.apply(schema, args) as T;
}

export const isoDateTimeSchema = z.string().datetime().openapi({
  description: "ISO 8601 timestamp.",
  example: "2025-01-01T00:00:00.000Z",
});

export const idempotencyKeyHeaderSchema = z.string().min(1).openapi({
  description: "Idempotency key for safely retrying mutating requests.",
  example: "idempotency_example_12345",
});

export const requestIdSchema = z.string().min(1).openapi({
  description: "Request identifier for tracing.",
  example: "req_example",
});

export const base64Schema = z.string().min(1).openapi({
  description: "Base64-encoded string.",
  example: "AQID",
});

export const solanaAddressSchema = z.string().min(32).max(44).openapi({
  description: "Base58-encoded Solana address.",
  example: "So11111111111111111111111111111111111111112",
});

const idSchema = (label: string, example: string) =>
  z.string().min(1).openapi({ description: label, example });

export const orgIdParamSchema = idSchema("Organization identifier.", "org_example");
export const apiKeyIdParamSchema = idSchema("API key identifier.", "key_example");
export const memberIdParamSchema = idSchema("Member identifier.", "mem_example");
export const projectIdParamSchema = idSchema("Project identifier.", "prj_example");
export const tokenIdParamSchema = idSchema("Token identifier.", "tok_example");
export const allowlistEntryIdParamSchema = idSchema("Allowlist entry identifier.", "al_example");
export const sessionIdParamSchema = idSchema("Session identifier.", "ses_example");
export const signingRequestIdParamSchema = idSchema(
  "Wallet signing request identifier.",
  "sigreq_example"
);
export const walletIdParamSchema = idSchema("Wallet identifier.", "wal_example");
export const transferIdParamSchema = idSchema(
  "Transfer identifier (SDP record ID, not the on-chain signature).",
  "xfr_example"
);

export const userIdSchema = idSchema("User identifier.", "usr_example");
export const invitationIdSchema = idSchema("Invitation identifier.", "inv_example");
export const projectMemberIdSchema = idSchema("Project member identifier.", "pm_example");
export const tokenTransactionIdSchema = idSchema("Token transaction identifier.", "ttx_example");
export const tokenAllowlistEntryIdSchema = idSchema(
  "Token allowlist entry identifier.",
  "tal_example"
);
export const frozenAccountIdSchema = idSchema("Frozen account identifier.", "frz_example");

export const apiKeyPrefixSchema = z.string().openapi({
  description: "API key prefix for display.",
  example: "sk_test_abc",
});

export const pageQuerySchema = z.number().int().positive().openapi({
  description: "Page number (1-based).",
  example: 1,
});

export const pageSizeQuerySchema = z.number().int().positive().openapi({
  description: "Number of items per page.",
  example: 50,
});

export const includeArchivedQuerySchema = z.boolean().openapi({
  description: "Include archived resources in results.",
  example: false,
});

export const tokenStatusQuerySchema = z
  .enum(["pending", "active", "paused", "revoked"])
  .openapi({ description: "Filter by token status.", example: "active" });

export const allowlistTypeQuerySchema = z
  .enum(["email", "domain"])
  .openapi({ description: "Filter by allowlist entry type.", example: "domain" });

export const allowlistStatusQuerySchema = z
  .enum(["active", "disabled"])
  .openapi({ description: "Filter by allowlist entry status.", example: "active" });

export const tokenTransactionStatusQuerySchema = z
  .enum(["pending", "processing", "confirmed", "finalized", "failed"])
  .openapi({ description: "Filter by token transaction status.", example: "confirmed" });

export const magicLinkTokenQuerySchema = z.string().openapi({
  description: "Magic link token from email.",
  example: "magic_token_example",
});

export const errorCodeSchema = z
  .enum([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
    "NOT_ALLOWLISTED",
    "INVALID_API_KEY",
    "EXPIRED_API_KEY",
    "REVOKED_API_KEY",
    "INSUFFICIENT_PERMISSIONS",
    "INVALID_INVITATION",
    "EXPIRED_INVITATION",
    "INVALID_TOKEN",
    "EXPIRED_SESSION",
    "TOKEN_NOT_FOUND",
    "TOKEN_NOT_ACTIVE",
    "TOKEN_NOT_MINTABLE",
    "TOKEN_NOT_DEPLOYED",
    "TOKEN_PAUSED",
    "NOT_ON_TOKEN_ALLOWLIST",
    "ON_TOKEN_BLOCKLIST",
    "ACCOUNT_FROZEN",
    "ACCOUNT_NOT_FROZEN",
    "MAX_SUPPLY_EXCEEDED",
    "SOLANA_RPC_ERROR",
    "CUSTODY_ERROR",
    "TRANSACTION_FAILED",
    "SIGNING_FAILED",
    "SIGNING_PENDING",
  ])
  .openapi({ description: "Machine-readable error code." });

export const errorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().openapi({ description: "Human-readable error message." }),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "Optional error details for debugging." }),
  })
  .openapi({ description: "Standard error payload." });

export const errorResponseSchema = z
  .object({
    error: errorSchema,
    meta: z
      .object({
        requestId: requestIdSchema.optional(),
      })
      .optional(),
  })
  .openapi({ description: "Standard error response envelope." });

const successMetaSchema = z
  .object({
    requestId: requestIdSchema,
    timestamp: isoDateTimeSchema,
  })
  .openapi({ description: "Response metadata." });

const paginatedMetaSchema = z
  .object({
    total: z.number().int().nonnegative().openapi({ description: "Total items." }),
    page: z.number().int().positive().openapi({ description: "Current page number." }),
    pageSize: z.number().int().positive().openapi({ description: "Items per page." }),
    hasMore: z.boolean().openapi({ description: "Whether more pages exist." }),
    requestId: requestIdSchema,
  })
  .openapi({ description: "Pagination metadata." });

export const successResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      data,
      meta: successMetaSchema,
    })
    .openapi({ description: "Standard success response envelope." });

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      data: z.array(data),
      meta: paginatedMetaSchema,
    })
    .openapi({ description: "Standard paginated response envelope." });

export const actionSuccessSchema = z
  .object({
    success: z.boolean().openapi({ description: "Operation success flag.", example: true }),
  })
  .openapi({ description: "Generic success response payload." });
