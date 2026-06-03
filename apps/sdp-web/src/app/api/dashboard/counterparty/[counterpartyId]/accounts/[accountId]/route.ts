import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ counterpartyId: string; accountId: string }> };

function accountPath(counterpartyId: string, accountId: string): string {
  return `/v1/counterparties/${encodeURIComponent(counterpartyId)}/accounts/${encodeURIComponent(accountId)}`;
}

export async function PATCH(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.accounts.update", request);

  try {
    const { counterpartyId, accountId } = await context.params;
    const body = await request.text();
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.accounts.api")
    );
    const response = await apiClient.request(accountPath(counterpartyId, accountId), {
      method: "PATCH",
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
      error: error instanceof Error ? error.message : "Failed to update counterparty account",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update counterparty account" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.counterparty.accounts.delete", request);

  try {
    const { counterpartyId, accountId } = await context.params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.counterparty.accounts.api")
    );
    const response = await apiClient.request(accountPath(counterpartyId, accountId), {
      method: "DELETE",
    });
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
      error: error instanceof Error ? error.message : "Failed to delete counterparty account",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete counterparty account" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
