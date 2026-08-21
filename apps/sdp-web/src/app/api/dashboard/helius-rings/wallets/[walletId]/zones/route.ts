import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.zones",
    path: `/v1/helius-rings/wallets/${encodeURIComponent(walletId)}/zones`,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ walletId: string }> }
) {
  const { walletId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.zones",
    path: `/v1/helius-rings/wallets/${encodeURIComponent(walletId)}/zones`,
  });
}
