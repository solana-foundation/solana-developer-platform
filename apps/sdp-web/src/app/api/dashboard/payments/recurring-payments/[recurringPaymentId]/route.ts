import { NextResponse } from "next/server";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

function disabledResponse() {
  return NextResponse.json(
    { error: { message: "Recurring payments are not enabled" } },
    { status: 404 }
  );
}

export async function GET(request: Request, context: RouteContext) {
  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse();
  }
  const { recurringPaymentId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.get",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse();
  }
  const { recurringPaymentId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.update",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}
