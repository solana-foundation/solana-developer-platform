import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfer-batches.get",
    path: `/v1/payments/transfer-batches/${encodeURIComponent(batchId)}`,
  });
}
