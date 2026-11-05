import { proxyToSdpApi } from "@/lib/sdp-api";

export async function DELETE(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members.leave",
    path: "/v1/members/me",
  });
}
