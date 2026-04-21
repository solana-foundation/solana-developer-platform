import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function POST(request: Request) {
  const trace = createTimedTrace("route.dashboard.compliance.address_screenings", request);

  try {
    const body = await request.text();
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.compliance.address_screenings.api")
    );
    const response = await apiClient.request("/v1/compliance/address-screenings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });

    const responseBody = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    const nextResponse = new NextResponse(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });

    logRouteResult(trace, response.status, {
      bodyBytes: body.length,
    });

    return nextResponse;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Compliance request failed",
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Compliance request failed",
    });
    return response;
  }
}
