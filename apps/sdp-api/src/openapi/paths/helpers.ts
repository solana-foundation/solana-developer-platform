import type { IdempotencyKeyMode } from "@sdp/types";
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
 * How a route's `idempotent({ key, serverErrors })` step behaves (ADR 0008),
 * restated for its OpenAPI header. `spec.test.ts` checks that every route's
 * documented header matches the mode its chain declares.
 */
export interface IdempotencyDocumentation {
  key: IdempotencyKeyMode;
  serverErrors: "store" | "rerun";
}

const IDEMPOTENCY_CONTRACT =
  "1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. " +
  "Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. " +
  "Keys are scoped to the credential: the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`. " +
  "A rotated API key is a new credential, so after a rotation read the resource with GET to learn whether the original request ran before sending it again. " +
  "A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. " +
  "A 400, 401, 403, 409 or 429 is not stored, so the same key runs again once the cause is fixed. " +
  "Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. " +
  "A replay is a snapshot of the original response: read the current state with GET instead of sending the request again.";

const SERVER_ERROR_RETRY: Record<IdempotencyDocumentation["serverErrors"], string> = {
  store: "A 5xx is stored and replayed like any other answer; retry it with a new key.",
  rerun:
    "After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer carries no `Idempotent-Replayed` header.",
};

/** The `Idempotency-Key` header description for a route's declared mode. */
export function idempotencyKeyDescription({ key, serverErrors }: IdempotencyDocumentation) {
  const lead =
    key === "required"
      ? "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`."
      : "Optional, and honored when sent.";
  return `${lead} ${IDEMPOTENCY_CONTRACT} ${SERVER_ERROR_RETRY[serverErrors]}`;
}

/**
 * Request headers for a `stable` route whose chain mounts `idempotent()`
 * (ADR 0008): required when the route moves money, optional otherwise. Routes
 * outside `stable` that keep their own key handling use
 * `projectScopeWithIdempotencyHeaders` or
 * `projectScopeWithRequiredIdempotencyHeaders`.
 */
export function projectScopeWithDeclaredIdempotencyHeaders(declared: IdempotencyDocumentation) {
  const description = idempotencyKeyDescription(declared);
  return projectScopeHeaders.extend({
    "Idempotency-Key":
      declared.key === "required"
        ? idempotencyKeyHeaderSchema.openapi({ description })
        : idempotencyKeyHeaderSchema.optional().openapi({ description }),
  });
}

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
