import type { Context, Next } from "hono";
import { badRequest } from "@/lib/errors";
import type { Env } from "@/types/env";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/**
 * The request's Idempotency-Key, or undefined when none was sent. A malformed
 * key (not 1-255 printable ASCII characters) is refused with 400.
 */
export function parseIdempotencyKey(c: Context): string | undefined {
  const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} must be 1-255 printable ASCII characters`);
  }
  return idempotencyKey;
}

/**
 * Validates the optional Idempotency-Key header (1-255 printable ASCII
 * characters, rejected with 400 otherwise) and echoes it back on the response.
 */
export function idempotencyKeyMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const idempotencyKey = parseIdempotencyKey(c);
    if (idempotencyKey !== undefined) {
      c.header(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    }
    await next();
  };
}
