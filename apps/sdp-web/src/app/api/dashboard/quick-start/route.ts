import { NextResponse } from "next/server";
import { loadQuickStartStatus } from "@/lib/quick-start-server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";

/**
 * The quick start's setup status, re-read while the guide is on screen so a first call made
 * from someone's own system ticks the step without a reload. Null when the viewer cannot
 * manage setup or the status is unknown, the same answer the layout seeds the guide with.
 */
export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.quick-start", request);
  const status = await trace.step("load_quick_start_status", () => loadQuickStartStatus());
  const response = NextResponse.json(
    { data: status },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
  logRouteResult(trace, 200, { known: status !== null });
  return response;
}
