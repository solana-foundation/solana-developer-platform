import type { Context, Next } from "hono";
import type { Env } from "@/types/env";

const TRACE_ID_HEADER = "X-SDP-Trace-ID";
const TRACE_SOURCE_HEADER = "X-SDP-Trace-Source";
const MAX_TRACE_ID_LENGTH = 128;
const MAX_TRACE_SOURCE_LENGTH = 64;
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const TRACE_SOURCE_PATTERN = /^[A-Za-z0-9._:-]+$/;

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function appendServerTiming(existingValue: string | null, nextEntry: string): string {
  return existingValue ? `${existingValue}, ${nextEntry}` : nextEntry;
}

function normalizeHeaderValue(
  value: string | null | undefined,
  maxLength: number,
  pattern: RegExp
): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.slice(0, maxLength);
  if (!pattern.test(candidate)) {
    return null;
  }

  return candidate;
}

export function requestTracingMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const startedAt = performance.now();
    const requestId = c.get("requestId");
    const traceId =
      normalizeHeaderValue(c.req.header(TRACE_ID_HEADER), MAX_TRACE_ID_LENGTH, TRACE_ID_PATTERN) ||
      requestId;
    const requestSource =
      normalizeHeaderValue(
        c.req.header(TRACE_SOURCE_HEADER),
        MAX_TRACE_SOURCE_LENGTH,
        TRACE_SOURCE_PATTERN
      ) || "unknown";

    c.set("traceId", traceId);
    c.set("requestSource", requestSource);

    try {
      await next();
    } finally {
      if (c.res) {
        const durationMs = roundDuration(performance.now() - startedAt);
        const pathname = new URL(c.req.url).pathname;

        c.header(TRACE_ID_HEADER, traceId);
        c.header(
          "Server-Timing",
          appendServerTiming(c.res.headers.get("Server-Timing"), `app;dur=${durationMs}`)
        );

        console.info(
          JSON.stringify({
            event: "sdp_api_request_timing",
            timestamp: new Date().toISOString(),
            requestId,
            traceId,
            source: requestSource,
            method: c.req.method,
            path: pathname,
            status: c.res.status,
            durationMs,
          })
        );
      }
    }
  };
}
