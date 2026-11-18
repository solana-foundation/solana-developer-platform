import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.get",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}`,
  });
}
