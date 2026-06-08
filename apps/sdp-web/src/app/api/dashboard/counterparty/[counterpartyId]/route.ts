import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string }> };

async function resolveCounterpartyId(context: RouteContext): Promise<string> {
  return (await context.params).counterpartyId;
}

export async function GET(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.get", request);

  try {
    const counterpartyId = await resolveCounterpartyId(context);
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.api")
    );
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}`
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
      error: error instanceof Error ? error.message : "Failed to fetch counterparty",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch counterparty" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.update", request);

  try {
    const counterpartyId = await resolveCounterpartyId(context);
    const body = await request.text();
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.api")
    );
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}`,
      { method: "PATCH", body }
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
      error: error instanceof Error ? error.message : "Failed to update counterparty",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update counterparty" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.delete", request);

  try {
    const counterpartyId = await resolveCounterpartyId(context);
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.api")
    );
    const response = await apiClient.request(
      `/v1/counterparties/${encodeURIComponent(counterpartyId)}`,
      { method: "DELETE" }
    );
    const body = await response.text();

    logRouteResult(trace, response.status);

    return new NextResponse(response.status === 204 ? null : body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to delete counterparty",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete counterparty" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
