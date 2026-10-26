import type { IdempotencyKeyMode } from "@sdp/types/idempotency";
import { z } from "zod";
import { idempotencyKeyHeaderSchema, projectScopeHeaderSchema } from "@/openapi/schemas/base";

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
 * How a route's `idempotent({ key, serverErrors, recovery })` step behaves
 * (ADR 0009), restated for its OpenAPI header. `spec.test.ts` checks that every
 * route's documented header matches the mode and recovery its chain declares.
 */
export interface IdempotencyDocumentation {
  key: IdempotencyKeyMode;
  serverErrors: "store" | "rerun";
  /**
   * The chain declares `recovery: "record"` (it mounts `replayFromRecord`), so
   * a retry after the original never recorded its outcome is answered from the
   * domain row instead of 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN`.
   */
  recovery?: "record";
  /**
   * The handler marks its domain row written (`markIdempotencyCommitted`), so
   * from then on any status is stored: transfers and transfer batches.
   */
  storesAnswerAfterRecord?: boolean;
}

const IDEMPOTENCY_CONTRACT =
  "1-255 printable ASCII characters; send a UUID per logical operation and reuse it on every retry. " +
  "Within 24 hours, a retry with the same key and the same request returns the stored status and body with the response header `Idempotent-Replayed: true`. " +
  "Keys are scoped to the credential: within 24 hours, the same key with a different request, or from a different credential, returns 422 `IDEMPOTENCY_KEY_REUSED`; after that, the same key from a different credential runs as a new request. " +
  "A rotated API key is a new credential, so after any rotation read the resource with GET to see whether the original request ran, and never resend a money request under the new credential without checking first. " +
  "A key whose original request is still running returns 409 `IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After`. " +
  "A 400, 401, 403, 409 or 429 refusal is not stored, so the same key runs again once the cause is fixed. " +
  "Access is checked before the key on every request, so a refused request never claims the key, and a credential that has since lost access to the named resource gets 403 instead of the stored response. " +
  "A replay is a snapshot of the original response: read the current state with GET instead of sending the request again.";

const SERVER_ERROR_RETRY = {
  store: "A 5xx is stored and replayed like any other answer; retry it with a new key.",
  rerun:
    "After a 5xx, a retry with the same key runs again and answers from the original record instead of acting twice; that answer also carries `Idempotent-Replayed: true`.",
} as const satisfies Record<IdempotencyDocumentation["serverErrors"], string>;

const UNRECORDED_OUTCOME = {
  record:
    "If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then takes over and is answered from the record it wrote.",
  none: "If the original request never recorded its outcome (it crashed), a same-key retry gets 409 `IDEMPOTENCY_KEY_IN_FLIGHT` until 15 minutes plus the route's lease have passed since the original was sent (about 16 minutes, or about 20 for transfer batches), then 409 `IDEMPOTENCY_KEY_OUTCOME_UNKNOWN` with no `Retry-After`, as does every later retry with that key: read the resource with GET to see whether it ran, then send again with a new key.",
} as const satisfies Record<"record" | "none", string>;

const ANSWER_AFTER_RECORD =
  "Once the request has written its record, any answer below 500 is stored: a transfer that fails after that (such as 400 `TRANSACTION_FAILED` or a 409 signer mismatch) answers a same-key retry with the same error and `Idempotent-Replayed: true`, and after 24 hours the record answers with the same status and code. A 5xx is not stored: a same-key retry runs again and is answered from the record. To try again after a failure, send the request with a new key.";

/** The `Idempotency-Key` header description for a route's declared mode. */
function idempotencyKeyDescription({
  key,
  serverErrors,
  recovery,
  storesAnswerAfterRecord,
}: IdempotencyDocumentation) {
  const lead =
    key === "required"
      ? "Required: a request without one returns 400 `IDEMPOTENCY_KEY_REQUIRED`."
      : "Optional, and honored when sent.";
  const afterRecord = storesAnswerAfterRecord ? ` ${ANSWER_AFTER_RECORD}` : "";
  const unrecorded = UNRECORDED_OUTCOME[recovery ?? "none"];
  return `${lead} ${IDEMPOTENCY_CONTRACT} ${unrecorded}${afterRecord} ${SERVER_ERROR_RETRY[serverErrors]}`;
}

/**
 * Request headers for a `stable` route whose chain mounts `idempotent()`
 * (ADR 0009): required when the route moves money, optional otherwise. Routes
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
