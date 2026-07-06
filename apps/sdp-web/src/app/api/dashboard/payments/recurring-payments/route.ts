import { NextResponse } from "next/server";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { proxyToSdpApi } from "@/lib/sdp-api";

function disabledResponse() {
  return NextResponse.json(
    { error: { message: "Recurring payments are not enabled" } },
    { status: 404 }
  );
}

export async function GET(request: Request) {
  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse();
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.list",
    path: `/v1/payments/recurring-payments${new URL(request.url).search}`,
  });
}

export async function POST(request: Request) {
  if (!isRecurringPaymentsDashboardEnabled()) {
    return disabledResponse();
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.create",
    path: "/v1/payments/recurring-payments",
  });
}
