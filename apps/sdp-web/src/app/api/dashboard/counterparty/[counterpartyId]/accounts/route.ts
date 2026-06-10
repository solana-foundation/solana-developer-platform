import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.accounts.list", request);

  try {
    const { counterpartyId } = await context.params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.accounts.api")
    );
    const search = new URL(request.url).searchParams.toString();
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts${search ? `?${search}` : ""}`
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
      error: error instanceof Error ? error.message : "Failed to fetch counterparty accounts",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch counterparty accounts" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.accounts.create", request);

  try {
    const { counterpartyId } = await context.params;
    const body = await request.text();
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.accounts.api")
    );
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts`,
      { method: "POST", body }
    );
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
      error: error instanceof Error ? error.message : "Failed to create counterparty account",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create counterparty account" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
