import type { Context, Next } from "hono";
import { badRequest } from "@/lib/errors";
import type { Env } from "@/types/env";

export const DRY_RUN_HEADER = "Dry-Run";

/**
 * Refuses any request that carries the retired Dry-Run header. The header used
 * to turn a money-moving request into a preview. A client that still sends it
 * must fail loudly, never sign and broadcast by accident. Any value is refused.
 */
export function dryRunRetiredMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (c.req.header(DRY_RUN_HEADER) !== undefined) {
      throw badRequest("Dry-Run is retired");
    }
    await next();
  };
}
