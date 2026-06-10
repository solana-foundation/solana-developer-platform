import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.requirements", request);

  try {
    const counterpartyId = (await context.params).counterpartyId;
    const search = new URL(request.url).search;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.requirements.api")
    );
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}/requirements${search}`
    );
    const body = await response.text();

    logRouteResult(trace, response.status);

    return new NextResponse(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to fetch counterparty requirements",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch counterparty requirements",
      },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
