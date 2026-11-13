import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { organizationId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.organizations.mainnet-access.notify",
    // The mainnet request page of an organization that lists no project sends none.
    organizationScoped: true,
    path: `/v1/organizations/${encodeURIComponent(organizationId)}/mainnet-access/notify`,
  });
}
