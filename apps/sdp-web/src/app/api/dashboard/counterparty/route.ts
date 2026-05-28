import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.counterparty.list", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.api")
    );
    const search = new URL(request.url).searchParams.toString();
    const response = await apiClient.request(`/v1/counterparties${search ? `?${search}` : ""}`);
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
      error: error instanceof Error ? error.message : "Failed to fetch counterparties",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch counterparties" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function POST(request: Request) {
  const trace = createTimedTrace("route.dashboard.counterparty.create", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.api")
    );
    const body = await request.text();
    const response = await apiClient.request("/v1/counterparties", {
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
      error: error instanceof Error ? error.message : "Failed to create counterparty",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create counterparty" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
