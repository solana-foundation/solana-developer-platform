import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ withdrawalId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { withdrawalId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.private-channels.withdrawals.get-by-id",
    path: `/v1/private-channels/withdrawals/${encodeURIComponent(withdrawalId)}`,
  });
}
