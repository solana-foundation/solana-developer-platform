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

/** Re-target the program's single vault in place. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.retarget",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}`,
  });
}
