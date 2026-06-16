import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function POST(request: Request) {
  const trace = createTimedTrace("route.dashboard.places.autocomplete", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.places.autocomplete.api")
    );
    const body = await request.text();
    const response = await apiClient.request("/v1/places/autocomplete", {
      method: "POST",
      body,
    });
    const responseBody = await response.text();

    logRouteResult(trace, response.status);

    return new NextResponse(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to autocomplete address",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to autocomplete address" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
