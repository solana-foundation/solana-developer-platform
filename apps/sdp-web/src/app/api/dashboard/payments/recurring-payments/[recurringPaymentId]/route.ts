import { NextResponse } from "next/server";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { getRecurringPaymentsProxyClient } from "../proxy-guard";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

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

export async function GET(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.recurring-payments.get", request);

  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse(trace);
  }

  try {
    const { recurringPaymentId } = await context.params;
    const proxyClient = await getRecurringPaymentsProxyClient(trace);
    if (!proxyClient.ok) {
      return proxyClient.response;
    }

    const response = await proxyClient.apiClient.request(
      `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
      { method: "GET" }
    );
    const body = await response.text();

    logRouteResult(trace, response.status, { recurringPaymentId });

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
      error: error instanceof Error ? error.message : "Failed to fetch recurring payment",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch recurring payment" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.recurring-payments.update", request);

  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse(trace);
  }

  try {
    const { recurringPaymentId } = await context.params;
    const body = await request.text();
    const proxyClient = await getRecurringPaymentsProxyClient(trace);
    if (!proxyClient.ok) {
      return proxyClient.response;
    }

    const response = await proxyClient.apiClient.request(
      `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      }
    );
    const responseBody = await response.text();

    logRouteResult(trace, response.status, { bodyBytes: body.length, recurringPaymentId });

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
      error: error instanceof Error ? error.message : "Failed to update recurring payment",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update recurring payment" },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
