import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.mints.get",
    path: `/v1/dvp/mints/${encodeURIComponent(mint)}`,
  });
}
