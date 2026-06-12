import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.places.static-map", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.places.static-map.api")
    );
    const search = new URL(request.url).searchParams.toString();
    const response = await apiClient.request(`/v1/places/static-map${search ? `?${search}` : ""}`);

    logRouteResult(trace, response.status);

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": response.ok ? "private, max-age=3600" : "no-store",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to fetch static map",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch static map" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
