import { readRecurringPaymentId } from "@/app/api/dashboard/payments/recurring-payments/recurring-payment-id";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const id = await readRecurringPaymentId(context);
  if (!id.ok) return id.response;
  const { recurringPaymentId } = id;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.collection-attempts.list",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/collection-attempts${new URL(request.url).search}`,
  });
}
