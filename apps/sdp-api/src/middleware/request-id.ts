/**
 * Request ID Middleware
 *
 * Generates or propagates a unique request ID for tracing.
 */

import { generateRequestId } from "@/lib/crypto";
import type { Env } from "@/types/env";
import type { Context, Next } from "hono";

export function requestIdMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Use provided request ID or generate a new one
    const requestId = c.req.header("X-Request-ID") || c.req.header("cf-ray") || generateRequestId();

    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    await next();
  };
}
