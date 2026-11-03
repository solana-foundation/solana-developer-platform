import { hashWebTraceId } from "@sdp/types/trace-correlation";
import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { getOptionalAuth } from "@/lib/auth";
import { runWithLogContext } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

const TRACE_ID_HEADER = "X-SDP-Trace-ID";
const TRACE_SOURCE_HEADER = "X-SDP-Trace-Source";

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function appendServerTiming(existingValue: string | null, nextEntry: string): string {
  return existingValue ? `${existingValue}, ${nextEntry}` : nextEntry;
}

function traceSource(value: string | undefined): string {
  if (value === "sdp-web") return "sdp-web";
  if (value?.startsWith("route.playground.")) return "playground";
  if (value?.startsWith("route.dashboard.") || value?.startsWith("dashboard.")) {
    return "dashboard";
  }
  return "unknown";
}

export function requestTracingMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const startedAt = performance.now();
    const requestId = c.get("requestId");
    const traceId = requestId;
    const requestSource = traceSource(c.req.header(TRACE_SOURCE_HEADER));
    const webTraceHash = await hashWebTraceId(c.req.header(TRACE_ID_HEADER)).catch(() => null);

    c.set("traceId", traceId);
    c.set("requestSource", requestSource);

    await runWithLogContext(
      {
        request_id: requestId,
        trace_id: traceId,
        web_trace_hash: webTraceHash ?? undefined,
      },
      async () => {
        try {
          await next();
        } finally {
          if (c.res) {
            const durationMs = roundDuration(performance.now() - startedAt);
            const auth = getOptionalAuth(c);
            const path = routePath(c, -1) || "unmatched";

            c.header(TRACE_ID_HEADER, traceId);
            c.header(
              "Server-Timing",
              appendServerTiming(c.res.headers.get("Server-Timing"), `app;dur=${durationMs}`)
            );

            logEvent("info", {
              event: "sdp_api_request_timing",
              source: requestSource,
              method: c.req.method,
              path,
              status: c.res.status,
              duration_ms: durationMs,
              organization_id: auth?.organizationId,
              project_id: auth?.projectId,
              api_key_id: auth?.apiKeyId,
              auth_type: auth?.authType,
            });
          }
        }
      }
    );
  };
}
