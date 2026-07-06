import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.wallets.balances.get",
    `/v1/payments/wallets/${encodeURIComponent(walletId)}/balances`
  );
}
