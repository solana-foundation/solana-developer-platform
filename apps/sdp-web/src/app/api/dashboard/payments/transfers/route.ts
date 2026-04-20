import { NextResponse } from "next/server";
import { fetchDashboardPaymentTransfers } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.payments.transfers.get", request);

  try {
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.payments.transfers.api")
    );
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const hasWalletFilter = url.searchParams.has("wallet") || url.searchParams.has("walletAddress");
    const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);

    if (!hasWalletFilter) {
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
        query: search,
        source: "dashboard_aggregate",
      });

      return nextResponse;
    }

    const response = await apiClient.request(
      `/v1/payments/transfers${search ? `?${search}` : ""}`,
      {
        method: "GET",
      }
    );

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
      query: search,
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
  const trace = createTimedTrace("route.dashboard.payments.transfers.post", request);

  try {
    const body = await request.text();
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.payments.transfers.api")
    );
    const response = await apiClient.request("/v1/payments/transfers", {
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
        error: error instanceof Error ? error.message : "Transfer request failed",
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
      error: error instanceof Error ? error.message : "Transfer request failed",
    });
    return response;
  }
}
