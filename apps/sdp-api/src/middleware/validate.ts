import type { Context, MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
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
 * parse with the schema (async, so refinements may be async — mirroring
 * `@hono/zod-validator`'s `safeParseAsync`), throw the target-appropriate 400
 * on failure, and hand the typed output to `c.req.valid(target)`.
 *
 * @param schema - The zod schema the target must satisfy.
 * @param toError - Error factory receiving the `{errors, formErrors?}` details.
 * @returns The validation function for hono's core `validator`.
 */
function zodValidation<S extends z.ZodType>(
  schema: S,
  toError: (details: Record<string, unknown>) => AppError
) {
  return async (value: unknown): Promise<z.output<S>> => {
    const parsed = await schema.safeParseAsync(value);
    if (!parsed.success) {
      throw toError(validationErrorDetails(parsed.error));
    }
    return parsed.data;
  };
}

/**
 * Maps a zod error onto the wire detail shape. `errors` is keyed by each
 * issue's FULL dot path (`identity.address.line1`, never collapsed to the
 * top-level field), and a strict schema's `unrecognized_keys` issue is
 * reported under the offending key itself rather than the empty root path.
 * Only issues with no path at all — the body not being an object — land in
 * `formErrors`.
 *
 * @param error - The zod error from a failed parse.
 * @returns The `{errors, formErrors?}` details for the 400 response.
 */
function validationErrorDetails(error: z.ZodError): Record<string, unknown> {
  const errors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  const addError = (path: string, message: string) => {
    const existing = errors[path];
    if (existing) {
      existing.push(message);
    } else {
      errors[path] = [message];
    }
  };
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        addError([...issue.path, key].join("."), "Unrecognized key");
      }
    } else if (issue.path.length === 0) {
      formErrors.push(issue.message);
    } else {
      addError(issue.path.join("."), issue.message);
    }
  }
  return { errors, ...(formErrors.length > 0 && { formErrors }) };
}

/**
 * Validates the JSON request body against a zod schema at the route level, so
 * validation runs before downstream middleware (metered quotas, policy gates)
 * and the handler. Handlers read the typed body via `c.req.valid("json")`.
 *
 * Mirrors `@hono/zod-validator`'s json target with one deliberate deviation:
 * the raw body is parsed regardless of the Content-Type header, where the
 * upstream validator's content-type gate leaves the body unread as `{}`. That
 * gate silently no-ops mistyped requests into 200s on all-optional schemas
 * and 400s bodyless requests that do send a JSON header. An empty or
 * whitespace-only body reaches the schema as an empty object; malformed JSON
 * is rejected with a 400. Reading via `c.req.text()` fills hono's body cache,
 * so downstream `c.req.json()` reads stay valid.
 *
 * @param schema - The zod schema the body must satisfy.
 * @returns Route-level middleware that rejects invalid bodies with a 400.
 */
export function validateBody<S extends z.ZodType<object>>(
  schema: S
  // biome-ignore lint/suspicious/noExplicitAny: mirrors hono's own validator() env default.
): MiddlewareHandler<any, string, { in: { json: z.input<S> }; out: { json: z.output<S> } }> {
  const parse = zodValidation(schema, (details) => badRequest("Invalid request body", details));
  return async (c, next) => {
    const raw = await c.req.text();
    let value: unknown = {};
    if (raw.trim().length > 0) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw badRequest("Malformed JSON in request body");
      }
    }
    c.req.addValidatedData("json", await parse(value));
    await next();
  };
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
