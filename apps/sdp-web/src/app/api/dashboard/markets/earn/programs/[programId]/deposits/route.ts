import { programProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.deposits.list",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}/deposits${programProxyQuery(request, { cursor: true })}`,
  });
}
