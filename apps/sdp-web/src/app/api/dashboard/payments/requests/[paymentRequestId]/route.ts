import { z } from "zod";
import { dashboardJson } from "@/lib/dashboard-response";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ paymentRequestId: string }> };

const routeParamsSchema = z.object({ paymentRequestId: z.string().trim().min(1) });

/** One payment request, read again while its page watches it for a payment. */
export async function GET(request: Request, context: RouteContext) {
  const params = routeParamsSchema.safeParse(await context.params);
  if (!params.success) {
    return dashboardJson({ error: { message: "Payment request id is required" } }, { status: 400 });
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payment-requests.detail",
    path: `/v1/payments/requests/${encodeURIComponent(params.data.paymentRequestId)}`,
  });
}
