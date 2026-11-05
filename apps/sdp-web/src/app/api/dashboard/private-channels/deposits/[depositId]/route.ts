import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ depositId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { depositId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.private-channels.deposits.get-by-id",
    path: `/v1/private-channels/deposits/${encodeURIComponent(depositId)}`,
  });
}
