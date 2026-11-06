import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ memberId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { memberId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members.update-role",
    path: `/v1/members/${encodeURIComponent(memberId)}`,
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { memberId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members.remove",
    path: `/v1/members/${encodeURIComponent(memberId)}`,
  });
}
