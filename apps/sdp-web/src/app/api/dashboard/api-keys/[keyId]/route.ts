import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ keyId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { keyId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.api-keys.get",
    path: `/v1/api-keys/${encodeURIComponent(keyId)}`,
  });
}
