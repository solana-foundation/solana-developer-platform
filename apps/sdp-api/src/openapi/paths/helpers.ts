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
 * For routes whose runtime refuses a request without the header: chains that
 * declare `idempotent({ key: "required" })` (ADR 0008), and the vault and
 * external-wallet money movers that keep their own handling. Marking it
 * optional here would let a generated client omit a header the API 400s on.
 */
export const projectScopeWithRequiredIdempotencyHeaders = projectScopeHeaders.extend({
  "Idempotency-Key": idempotencyKeyHeaderSchema,
});

/**
 * Request headers for routes whose chain declares `idempotent({ key: "accepted" })`
 * (ADR 0008): the key is optional and honored when sent. Routes outside `stable`
 * that keep their own key handling use `projectScopeWithIdempotencyHeaders`.
 */
export const projectScopeWithAcceptedIdempotencyHeaders = projectScopeHeaders.extend({
  "Idempotency-Key": idempotencyKeyHeaderSchema.optional().openapi({
    description:
      "Optional. 1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and request replays the stored status and body with `Idempotent-Replayed: true`; the same key with a different request or credential, or after the credential's access changed, returns 422 `IDEMPOTENCY_KEY_REUSED`, and a key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`.",
  }),
});

/**
 * Operation-description suffix for routes whose chain declares
 * `idempotent({ key: "required" })` (ADR 0008). The API has no response-header
 * pattern, so `Idempotent-Replayed` is documented here.
 */
export const REQUIRED_IDEMPOTENCY_KEY_DESCRIPTION =
  "The `Idempotency-Key` header is required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`. Send a UUID per logical operation and reuse it on every retry. Within 24 hours, a retry with the same key and request replays the stored status and body with the response header `Idempotent-Replayed: true`; the same key with a different request or credential, or after the credential's access changed, returns 422 `IDEMPOTENCY_KEY_REUSED`, and a key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`.";

export const errorResponses = (schema: z.ZodTypeAny, codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      {
        description: "Error",
        content: jsonContent(schema),
      },
    ])
  );
