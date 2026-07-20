import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ transferId: string }> }) {
  const { transferId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transactions.detail",
    path: `/v1/payments/transfers/${encodeURIComponent(transferId)}`,
  });
}
