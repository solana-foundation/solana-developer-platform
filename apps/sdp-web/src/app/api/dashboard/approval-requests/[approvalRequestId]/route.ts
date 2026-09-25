import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";
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
    // The detail view binds its refreshes to the project it rendered with;
    // without the binding the proxy resolves the shared selection cookie.
    boundProjectId: request.headers.get(PROJECT_HEADER_NAME) ?? undefined,
  });
}
