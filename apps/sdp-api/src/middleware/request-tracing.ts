import type { Context, Next } from "hono";
import { getLogger, runWithLogContext } from "@/runtime/logger";
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

/**
 * Credential-free route identity for telemetry sinks.
 *
 * Request paths can embed bearer credentials — the public `/pay/:token`
 * route authorizes a payment read by the token in the URL alone — so no
 * telemetry field may carry the concrete pathname. Callers log the matched
 * route template (e.g. `/pay/:token`) instead: method, status, duration, and
 * request ids stay joinable while the credential never serializes. The
 * lookup resolves the matched endpoint even when a global middleware
 * rejected the request before its handler ran (`routeIndex` still points at
 * the middleware's `*` entry), so rejected requests keep grouping by
 * endpoint, and unmatched requests resolve to the catch-all pattern, which
 * carries no request data. Never log `c.req.url`/`c.req.path` instead.
 */
export function routeTemplateForTelemetry(c: Context<{ Bindings: Env }>): string {
  const routes = c.req.matchedRoutes;
  // The endpoint is the last matched entry; reverse order also keeps a
  // path-scoped middleware from shadowing the route that would have served
  // the request. Every template is static, so none carries request data.
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i].path;
    if (path !== "*") {
      return path;
    }
  }
  return "*";
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

    await runWithLogContext({ request_id: requestId, trace_id: traceId }, async () => {
      try {
        await next();
      } finally {
        if (c.res) {
          const durationMs = roundDuration(performance.now() - startedAt);

          c.header(TRACE_ID_HEADER, traceId);
          c.header(
            "Server-Timing",
            appendServerTiming(c.res.headers.get("Server-Timing"), `app;dur=${durationMs}`)
          );

          getLogger().info(
            {
              event: "sdp_api_request_timing",
              source: requestSource,
              method: c.req.method,
              path: routeTemplateForTelemetry(c),
              status: c.res.status,
              duration_ms: durationMs,
            },
            "request completed"
          );
        }
      }
    });
  };
}
