import { NextResponse } from "next/server";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { getRecurringPaymentsProxyClient } from "../../proxy-guard";

type RecurringPaymentAction = "activate" | "collect" | "cancel" | "resume";
type RouteContext = {
  params: Promise<{ recurringPaymentId: string; action: string }>;
};

const ACTIONS = new Set<RecurringPaymentAction>(["activate", "collect", "cancel", "resume"]);

function isRecurringPaymentAction(action: string): action is RecurringPaymentAction {
  return ACTIONS.has(action as RecurringPaymentAction);
}

function jsonWithTrace(
  trace: ReturnType<typeof createTimedTrace>,
  status: number,
  message: string
) {
  logRouteResult(trace, status, { error: message });
  return NextResponse.json(
    { error: { message } },
    {
      status,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

export async function POST(request: Request, context: RouteContext) {
  const trace = createTimedTrace("route.dashboard.recurring-payments.action", request);

  if (!isRecurringPaymentsDashboardEnabled()) {
    return jsonWithTrace(trace, 404, "Recurring payments are not enabled");
  }

  try {
    const { recurringPaymentId, action } = await context.params;
    if (!isRecurringPaymentAction(action)) {
      return jsonWithTrace(trace, 404, "Recurring payment action is not supported");
    }

    const proxyClient = await getRecurringPaymentsProxyClient(trace);
    if (!proxyClient.ok) {
      return proxyClient.response;
    }

    const body = await request.text();
    const response = await proxyClient.apiClient.request(
      `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body || "{}",
      }
    );
    const responseBody = await response.text();

    logRouteResult(trace, response.status, { action, recurringPaymentId });

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
      error: error instanceof Error ? error.message : "Failed to run recurring payment action",
    });
    return NextResponse.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Failed to run recurring payment action",
        },
      },
      {
        status: 500,
        headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
      }
    );
  }
}
