import { NextResponse } from "next/server";
import { fetchDashboardPaymentTransfers } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, getSelectedProjectId, proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Not a pure proxy: without a direct filter this aggregates transfers via
 * fetchDashboardPaymentTransfers, so that branch builds its own client and
 * must repeat proxyToSdpApi's missing-project 400 up front — otherwise
 * createSdpApiClient's throw would surface as a 500.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const hasDirectTransferFilter = [
    "wallet",
    "walletAddress",
    "provider",
    "providerReference",
    "category",
    "counterpartyId",
  ].some((param) => url.searchParams.has(param));

  if (hasDirectTransferFilter) {
    return proxyToSdpApi({
      request,
      traceSource: "route.dashboard.payments.transfers.get",
      path: `/v1/payments/transfers${url.search}`,
    });
  }

  const trace = createTimedTrace("route.dashboard.payments.transfers.get", request);

  const projectId = await getSelectedProjectId();
  if (!projectId) {
    logRouteResult(trace, 400, { error: "Selected project required" });
    return NextResponse.json(
      { error: { message: "Selected project required" } },
      {
        status: 400,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.payments.transfers.api")
    );
    const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
    const result = await fetchDashboardPaymentTransfers(
      apiClient.request,
      Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20
    );
    const status = result.ok ? 200 : (result.status ?? 500);
    const nextResponse = NextResponse.json(
      result.ok
        ? { data: result.data ?? [] }
        : { error: { message: result.error ?? "Transfer list request failed" } },
      {
        status,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, status, {
      query: url.searchParams.toString(),
      source: "dashboard_aggregate",
    });

    return nextResponse;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Transfer list request failed",
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
      error: error instanceof Error ? error.message : "Transfer list request failed",
    });
    return response;
  }
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfers.post",
    path: "/v1/payments/transfers",
  });
}
