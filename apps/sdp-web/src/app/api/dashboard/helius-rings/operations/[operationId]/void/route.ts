import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operationId: string }> }
) {
  const { operationId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.void",
    path: `/v1/helius-rings/operations/${encodeURIComponent(operationId)}/void`,
  });
}
