import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { recurringPaymentId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.collection-attempts.list",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/collection-attempts${new URL(request.url).search}`,
  });
}
