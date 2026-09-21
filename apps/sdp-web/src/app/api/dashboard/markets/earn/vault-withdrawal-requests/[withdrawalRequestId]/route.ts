import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ withdrawalRequestId: string }> }
) {
  const { withdrawalRequestId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.vault_withdrawal_requests.get",
    path: `/v1/earn/vault-withdrawal-requests/${encodeURIComponent(withdrawalRequestId)}`,
  });
}
