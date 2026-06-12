import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ placeId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.places.get", request);

  try {
    const { placeId } = await context.params;
    const apiClient = await createSdpApiClient(trace.childContext("route.dashboard.places.api"));
    const search = new URL(request.url).searchParams.toString();
    const response = await apiClient.request(
      `/v1/places/${encodeURIComponent(placeId)}${search ? `?${search}` : ""}`
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
      error: error instanceof Error ? error.message : "Failed to fetch place details",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch place details" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
