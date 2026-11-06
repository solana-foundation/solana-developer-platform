import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ invitationId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const { invitationId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members.invitation.revoke",
    path: `/v1/members/invitations/${encodeURIComponent(invitationId)}`,
  });
}
