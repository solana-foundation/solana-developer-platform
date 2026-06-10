import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.counterparty.metadata", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.metadata.api")
    );
    const response = await apiClient.request("/v1/counterparties/metadata");
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
      error: error instanceof Error ? error.message : "Failed to fetch counterparty metadata",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch counterparty metadata" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
