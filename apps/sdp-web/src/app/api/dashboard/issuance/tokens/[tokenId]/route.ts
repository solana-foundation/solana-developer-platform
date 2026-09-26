import { proxyToSdpApi, readProjectContextId } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ tokenId: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  const { tokenId } = await context.params;

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.issuance.token.update",
    path: `/v1/issuance/tokens/${encodeURIComponent(tokenId)}`,
    boundProjectId: readProjectContextId(request),
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { tokenId } = await context.params;

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.issuance.token.get",
    path: `/v1/issuance/tokens/${encodeURIComponent(tokenId)}${new URL(request.url).search}`,
    boundProjectId: readProjectContextId(request),
  });
}
