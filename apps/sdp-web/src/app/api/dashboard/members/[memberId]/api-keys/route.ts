import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ memberId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { memberId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members.api-keys",
    path: `/v1/members/${encodeURIComponent(memberId)}/api-keys`,
  });
}
