import { readRecurringPaymentId } from "@/app/api/dashboard/payments/recurring-payments/recurring-payment-id";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const id = await readRecurringPaymentId(context);
  if (!id.ok) return id.response;
  const { recurringPaymentId } = id;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.get",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const id = await readRecurringPaymentId(context);
  if (!id.ok) return id.response;
  const { recurringPaymentId } = id;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.update",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`,
  });
}
