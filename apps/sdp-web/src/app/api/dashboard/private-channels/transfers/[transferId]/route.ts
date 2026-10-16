import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ transferId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { transferId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.private-channels.transfers.get-by-id",
    path: `/v1/private-channels/transfers/${encodeURIComponent(transferId)}`,
  });
}
