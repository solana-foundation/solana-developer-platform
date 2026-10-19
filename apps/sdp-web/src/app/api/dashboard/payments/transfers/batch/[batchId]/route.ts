import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { batchId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfers.batch.get-by-id",
    path: `/v1/payments/transfer-batches/${encodeURIComponent(batchId)}`,
  });
}
