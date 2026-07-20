import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ approvalRequestId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { approvalRequestId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.approval-requests.detail",
    path: `/v1/wallets/approval-requests/${encodeURIComponent(approvalRequestId)}`,
  });
}
