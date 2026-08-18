import type { Context } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { type AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import type { Env } from "@/types/env";

type ValidatedTarget = "json" | "query" | "param";

type ValidatedSchemas = Partial<Record<ValidatedTarget, z.ZodType>>;

export type ValidatedContext<T extends ValidatedSchemas> = Context<
  { Bindings: Env },
  // biome-ignore lint/suspicious/noExplicitAny: mirrors hono Context's own path default; a narrower type degrades c.req.param() typing.
  any,
  {
    in: { [K in keyof T & string]: z.input<NonNullable<T[K]>> };
    out: { [K in keyof T & string]: z.output<NonNullable<T[K]>> };
  }
>;

export type ValidatedBodyContext<S extends z.ZodType> = ValidatedContext<{ json: S }>;

/**
 * Builds the zod validation function shared by the route-level validators:
 * parse with the schema, throw the target-appropriate 400 on failure, and
 * hand the typed output to `c.req.valid(target)`.
 *
 * @param schema - The zod schema the target must satisfy.
 * @param toError - Error factory receiving the flattened field errors.
 * @returns The validation function for hono's core `validator`.
 */
function zodValidation<S extends z.ZodType>(
  schema: S,
  toError: (details: Record<string, unknown>) => AppError
) {
  return (value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const flattened = z.flattenError(parsed.error);
      throw toError({
        errors: flattened.fieldErrors,
        ...(flattened.formErrors.length > 0 && { formErrors: flattened.formErrors }),
      });
    }
    return parsed.data;
  };
}

/**
 * Validates the JSON request body against a zod schema at the route level, so
 * validation runs before downstream middleware (metered quotas, policy gates)
 * and the handler. Handlers read the typed body via `c.req.valid("json")`.
 *
 * Requests without a JSON Content-Type reach the schema as an empty object,
 * and malformed JSON is rejected by the core validator with a 400 before the
 * schema runs.
 *
 * @param schema - The zod schema the body must satisfy.
 * @returns Route-level middleware that rejects invalid bodies with a 400.
 */
export function validateBody<S extends z.ZodType>(schema: S) {
  return validator(
    "json",
    zodValidation(schema, (details) => badRequest("Invalid request body", details))
  );
}

/**
 * Validates the query string against a zod schema at the route level.
 * Handlers read the typed query via `c.req.valid("query")`.
 *
 * @param schema - The zod schema the query parameters must satisfy.
 * @returns Route-level middleware that rejects invalid queries with a 400.
 */
export function validateQuery<S extends z.ZodType>(schema: S) {
  return validator("query", zodValidation(schema, badRequestQuery));
}

/**
 * Validates path parameters against a zod schema at the route level.
 * Handlers read the typed params via `c.req.valid("param")`.
 *
 * @param schema - The zod schema the path parameters must satisfy.
 * @returns Route-level middleware that rejects invalid params with a 400.
 */
export function validateParams<S extends z.ZodType>(schema: S) {
  return validator("param", zodValidation(schema, badRequestParams));
}
