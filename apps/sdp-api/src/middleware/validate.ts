import type { Context, MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { type AppError, badRequest } from "@/lib/errors";
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
 * On failure the 400's message carries `z.prettifyError`'s rendering — one
 * `✖ <message>` line per issue with its full `→ at profile.address.line1`
 * path — deliberately the whole contract: one readable string, no parallel
 * machine-readable detail payload.
 *
 * @param schema - The zod schema the target must satisfy.
 * @param toError - Error factory receiving the prettified zod error.
 * @returns The validation function for hono's core `validator`.
 */
function zodValidation<S extends z.ZodType>(schema: S, toError: (prettified: string) => AppError) {
  return async (value: unknown): Promise<z.output<S>> => {
    const parsed = await schema.safeParseAsync(value);
    if (!parsed.success) {
      throw toError(z.prettifyError(parsed.error));
    }
    return parsed.data;
  };
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
  const parse = zodValidation(schema, (prettified) =>
    badRequest(`Invalid request body:\n${prettified}`)
  );
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
  return validator(
    "query",
    zodValidation(schema, (prettified) => badRequest(`Invalid query parameters:\n${prettified}`))
  );
}

/**
 * Validates path parameters against a zod schema at the route level.
 * Handlers read the typed params via `c.req.valid("param")`.
 *
 * @param schema - The zod schema the path parameters must satisfy.
 * @returns Route-level middleware that rejects invalid params with a 400.
 */
export function validateParams<S extends z.ZodType>(schema: S) {
  return validator(
    "param",
    zodValidation(schema, (prettified) => badRequest(`Invalid path parameters:\n${prettified}`))
  );
}
