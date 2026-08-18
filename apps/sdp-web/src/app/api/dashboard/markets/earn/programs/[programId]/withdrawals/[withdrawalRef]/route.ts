import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ programId: string; withdrawalRef: string }> }
) {
  const { programId, withdrawalRef } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.withdrawals.get",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}/withdrawals/${encodeURIComponent(withdrawalRef)}`,
  });
}
