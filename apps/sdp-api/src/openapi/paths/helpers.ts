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

export const projectScopeWithIdempotencyHeaders = projectScopeHeaders.extend({
  "Idempotency-Key": idempotencyKeyHeaderSchema.optional(),
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
