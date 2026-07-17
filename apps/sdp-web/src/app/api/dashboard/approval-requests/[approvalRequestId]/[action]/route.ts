import { NextResponse } from "next/server";
import { isApprovalAction } from "@/app/dashboard/approvals/approval-actions";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ approvalRequestId: string; action: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { approvalRequestId, action } = await context.params;
  if (!isApprovalAction(action)) {
    return NextResponse.json(
      { error: { message: "Approval request action is not supported" } },
      { status: 404 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: `route.dashboard.approval-requests.${action}`,
    path: `/v1/wallets/approval-requests/${encodeURIComponent(approvalRequestId)}/${action}`,
  });
}
