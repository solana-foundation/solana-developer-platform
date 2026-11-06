import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { organizationId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.organizations.mainnet-access.request",
    path: `/v1/organizations/${encodeURIComponent(organizationId)}/mainnet-access`,
  });
}
