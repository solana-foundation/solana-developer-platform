import type { Context, Next } from "hono";
import { badRequest } from "@/lib/errors";
import type { Env } from "@/types/env";

const DRY_RUN_HEADER = "Dry-Run";

/**
 * Validates the optional Dry-Run header (exactly "true" or "false" after
 * trimming, rejected with 400 otherwise).
 *
 * @returns Hono middleware enforcing the Dry-Run header vocabulary.
 */
export function dryRunMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const value = c.req.header(DRY_RUN_HEADER);
    if (value !== undefined) {
      const normalized = value.trim();
      if (normalized !== "true" && normalized !== "false") {
        throw badRequest(`${DRY_RUN_HEADER} must be exactly true or false`);
      }
    }
    await next();
  };
}

/**
 * Reports whether the request opted into a policy dry-run via the Dry-Run
 * header, assuming dryRunMiddleware already rejected invalid values.
 *
 * @param c - Request context.
 * @returns True when the Dry-Run header is set to "true".
 */
export function isDryRunRequest(c: Context<{ Bindings: Env }>): boolean {
  const value = c.req.header(DRY_RUN_HEADER);
  return value !== undefined && value.trim() === "true";
}
