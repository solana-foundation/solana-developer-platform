import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.wallets.policies.get",
    path: `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`,
  });
}

export async function PUT(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.wallets.policies.put",
    path: `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`,
  });
}
