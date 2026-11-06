import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ organizationId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { organizationId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.organizations.update",
    path: `/v1/organizations/${encodeURIComponent(organizationId)}`,
  });
}
