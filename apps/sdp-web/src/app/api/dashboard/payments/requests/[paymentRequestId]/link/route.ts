import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ paymentRequestId: string }> };

/**
 * A payment request's link token. The API answers it only to a member whose
 * role holds `payment_requests.manage` (APE-849).
 */
export async function GET(request: Request, context: RouteContext) {
  const { paymentRequestId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payment-requests.link",
    path: `/v1/payments/requests/${encodeURIComponent(paymentRequestId)}/link`,
  });
}
