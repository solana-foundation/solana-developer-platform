import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ operationId: string }> }
) {
  const { operationId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.operation",
    path: `/v1/helius-rings/operations/${encodeURIComponent(operationId)}`,
  });
}
