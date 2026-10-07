import { idempotencyKeyHeaderSchema, projectScopeHeaderSchema, z } from "../schemas";

export const jsonContent = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

/**
 * Shared request headers for routes gated by `projectContextMiddleware`.
 * `x-project-id` selects the active project for Clerk (dashboard) callers and
 * is ignored when authenticating with an API key (scope is fixed to the key).
 */
export const projectScopeHeaders = z.object({
  "x-project-id": projectScopeHeaderSchema.optional(),
});

export const projectScopeWithIdempotencyHeaders = projectScopeHeaders.extend({
  "Idempotency-Key": idempotencyKeyHeaderSchema.optional(),
});

/**
 * For routes where the header is the ONLY accepted idempotency source and the
 * runtime refuses a request without it (the vault and external-wallet money
 * movers). Marking it optional here would let a generated client omit a header
 * the API 400s on.
 */
export const projectScopeWithRequiredIdempotencyHeaders = projectScopeHeaders.extend({
  "Idempotency-Key": idempotencyKeyHeaderSchema,
});

/**
 * What each documented error status means across the API, matching the codes
 * ERROR_STATUS_CODES in lib/errors.ts maps to it. `error.code` in the body
 * names the specific failure.
 */
const ERROR_RESPONSE_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "Bad request. The body, path, query, or a header failed validation, or the operation is not valid for the resource's current state (for example `TOKEN_PAUSED` or `INSUFFICIENT_TOKEN_BALANCE`).",
  401: "Unauthorized. The API key or session is missing, invalid, revoked, or expired (`UNAUTHORIZED`, `INVALID_API_KEY`, `REVOKED_API_KEY`, `EXPIRED_API_KEY`).",
  403: "Forbidden. The caller lacks a required permission (`INSUFFICIENT_PERMISSIONS`), or a policy, IP allowlist, or token access rule refused the request (`FORBIDDEN`, `NOT_ON_TOKEN_ALLOWLIST`).",
  404: "Not found. The resource does not exist, or it belongs to another project.",
  409: "Conflict. The request conflicts with the resource's current state, or an `Idempotency-Key` was reused with a different payload (`CONFLICT`).",
  413: "Payload too large (`PAYLOAD_TOO_LARGE`).",
  422: "The custody provider refused to sign the transaction (`SIGNING_REJECTED`).",
  429: "Too many requests. A rate limit or quota was exceeded (`RATE_LIMITED`).",
  500: "Internal error (`INTERNAL_ERROR`).",
  501: "Not implemented for this resource or deployment.",
  502: "An upstream custody provider or Solana RPC returned an error (`CUSTODY_ERROR`, `SOLANA_RPC_ERROR`).",
  503: "Service unavailable. A provider or dependency is not configured or could not be reached (`PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `SERVICE_UNAVAILABLE`).",
  504: "Solana RPC timed out (`SOLANA_RPC_TIMEOUT`).",
};

/**
 * Error responses for an operation. Each status gets the shared description
 * above; `overrides` replaces it where an operation's meaning is narrower.
 */
export const errorResponses = (
  schema: z.ZodTypeAny,
  codes: number[],
  overrides: Readonly<Partial<Record<number, string>>> = {}
) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      {
        description: overrides[code] ?? ERROR_RESPONSE_DESCRIPTIONS[code] ?? "Error",
        content: jsonContent(schema),
      },
    ])
  );
