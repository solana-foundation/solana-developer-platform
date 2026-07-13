/**
 * Request ID Middleware
 *
 * Generates or propagates a unique request ID for tracing.
 */

import type { Context, Next } from "hono";
import type { Env } from "@/types/env";

const REQUEST_ID_HEADER = "X-Request-ID";
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function stripControlChars(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      result += value[i];
    }
  }
  return result;
}

function normalizeRequestId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = stripControlChars(value.trim());
  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.slice(0, MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(candidate)) {
    return null;
  }

  return candidate;
}

export function requestIdMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Use provided request ID or generate a new one
    const requestId =
      normalizeRequestId(c.req.header(REQUEST_ID_HEADER)) ||
      normalizeRequestId(c.req.header("cf-ray")) ||
      `req_${crypto.randomUUID()}`;

    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);

    await next();
  };
}
