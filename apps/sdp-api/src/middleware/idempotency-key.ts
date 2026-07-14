import type { Context, Next } from "hono";
import { badRequest } from "@/lib/errors";
import type { Env } from "@/types/env";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/**
 * Validates the optional Idempotency-Key header (1-255 printable ASCII
 * characters, rejected with 400 otherwise) and echoes it back on the response.
 */
export function idempotencyKeyMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw badRequest(`${IDEMPOTENCY_KEY_HEADER} must be 1-255 printable ASCII characters`);
      }
      c.header(IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    }
    await next();
  };
}
