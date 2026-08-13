import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.withdrawal-preview",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}/withdrawal-preview`,
  });
}
