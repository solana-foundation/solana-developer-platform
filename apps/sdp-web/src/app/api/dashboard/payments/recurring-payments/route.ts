import { NextResponse } from "next/server";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { getRecurringPaymentsProxyClient } from "./proxy-guard";

function disabledResponse(trace: ReturnType<typeof createTimedTrace>) {
  logRouteResult(trace, 404, { recurringPaymentsEnabled: false });
  return NextResponse.json(
    { error: { message: "Recurring payments are not enabled" } },
    {
      status: 404,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.recurring-payments.list", request);

  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse(trace);
  }

  try {
    const proxyClient = await getRecurringPaymentsProxyClient(trace);
    if (!proxyClient.ok) {
      return proxyClient.response;
    }

    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const response = await proxyClient.apiClient.request(
      `/v1/payments/recurring-payments${search ? `?${search}` : ""}`,
      { method: "GET" }
    );
    const body = await response.text();

    logRouteResult(trace, response.status, { query: search });

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
      error: error instanceof Error ? error.message : "Failed to list recurring payments",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list recurring payments" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function POST(request: Request) {
  const trace = createTimedTrace("route.dashboard.recurring-payments.create", request);

  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse(trace);
  }

  try {
    const body = await request.text();
    const proxyClient = await getRecurringPaymentsProxyClient(trace);
    if (!proxyClient.ok) {
      return proxyClient.response;
    }

    const response = await proxyClient.apiClient.request("/v1/payments/recurring-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const responseBody = await response.text();

    logRouteResult(trace, response.status, { bodyBytes: body.length });

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
      error: error instanceof Error ? error.message : "Failed to create recurring payment",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create recurring payment" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
