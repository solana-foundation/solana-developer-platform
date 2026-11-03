/**
 * Request ID Middleware
 *
 * Generates a unique request ID for tracing.
 */

import type { Context, Next } from "hono";
import type { Env } from "@/types/env";

const REQUEST_ID_HEADER = "X-Request-ID";

export function requestIdMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Caller-controlled IDs cannot enter the log context, which bypasses scrubbing.
    const requestId = `req_${crypto.randomUUID()}`;

    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);

    await next();
  };
}
