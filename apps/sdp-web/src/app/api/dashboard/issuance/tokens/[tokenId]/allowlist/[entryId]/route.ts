import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ tokenId: string; entryId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const { tokenId, entryId } = await context.params;

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.issuance.token.allowlist.remove",
    path: `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/allowlist/${encodeURIComponent(entryId)}`,
  });
}
