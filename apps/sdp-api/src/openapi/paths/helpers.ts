import { idempotencyKeyHeaderSchema, projectScopeHeaderSchema, z } from "../schemas";

export const jsonContent = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

/**
 * Shared request headers for routes gated by `projectContextMiddleware`.
 * `x-project-id` selects the active project for session/dashboard callers and
 * is ignored when authenticating with an API key (scope is fixed to the key).
 */
export const projectScopeHeaders = z.object({
  "x-project-id": projectScopeHeaderSchema.optional(),
});

/** Required project selection for session-only operations. */
export const sessionProjectScopeHeaders = z.object({
  "x-project-id": projectScopeHeaderSchema,
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
