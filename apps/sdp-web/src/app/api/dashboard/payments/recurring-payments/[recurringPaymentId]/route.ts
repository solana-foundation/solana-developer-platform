import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { recurringPaymentId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.get",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { recurringPaymentId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.update",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}
