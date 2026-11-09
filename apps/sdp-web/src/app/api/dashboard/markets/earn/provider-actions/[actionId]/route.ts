import { proxyToSdpApi } from "@/lib/sdp-api";
export async function GET(request: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.provider_actions.get",
    path: `/v1/earn/provider-actions/${encodeURIComponent(actionId)}`,
  });
}
