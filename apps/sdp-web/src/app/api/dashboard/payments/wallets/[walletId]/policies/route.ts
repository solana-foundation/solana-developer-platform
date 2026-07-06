import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.wallets.policies.get",
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`
  );
}

export async function PUT(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.wallets.policies.put",
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/policies`
  );
}
